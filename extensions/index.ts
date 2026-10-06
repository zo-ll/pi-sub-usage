/**
 * Subscription usage for Pi.
 *
 * Adds:
 *   /usage   - a refreshable panel with the active subscription limits
 *   status   - a compact "usage" status item in the footer
 *
 * Providers (subscription plans only, no API spend):
 *   opencode-go   OpenCode Zen Go plan      (stored API key, /zen/go/v1/usage)
 *   openai-codex  OpenAI ChatGPT Plus/Pro   (OAuth, chatgpt.com wham/usage)
 *   anthropic     Anthropic Claude Pro/Max  (OAuth, api.anthropic.com usage)
 *
 * The extension is read-only. It resolves the credential that Pi already
 * stores, calls the provider's own usage endpoint, and prints the result.
 * It never writes credentials and never sends a credential anywhere else.
 */

import {
	readStoredCredential,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";

const STATUS_KEY = "usage";
const USER_AGENT = "pi-usage-sub/0.1";
const REQUEST_TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 60_000;
const STATUS_REFRESH_MS = 5 * 60_000;

const OPENCODE_GO_URL = "https://opencode.ai/zen/go/v1/usage";
const CODEX_URL = "https://chatgpt.com/backend-api/wham/usage";
const ANTHROPIC_URL = "https://api.anthropic.com/api/oauth/usage";
// Claude Code sends this beta flag on the OAuth usage endpoint.
const ANTHROPIC_BETA = "oauth-2025-04-20";

interface UsageWindow {
	/** "5h", "7d", or "30d" */
	label: string;
	/** Percent of the allowance already used, 0-100. */
	usedPercent: number;
	/** Reset time, epoch milliseconds. */
	resetsAt?: number;
}

interface ProviderReport {
	id: string;
	name: string;
	account?: string;
	plan?: string;
	windows: UsageWindow[];
	error?: string;
}

interface ResolvedAuth {
	isOAuth: boolean;
	apiKey?: string;
}

/* ------------------------------------------------------------------ */
/* Auth resolution                                                     */
/* ------------------------------------------------------------------ */

function findModel(ctx: ExtensionContext, providerId: string) {
	const all = ctx.modelRegistry.getAll();
	const available = ctx.modelRegistry.getAvailable();
	const preferred = ctx.model?.provider === providerId ? ctx.model.id : undefined;
	const pick = (list: typeof all) => {
		if (preferred) {
			const match = list.find((m) => m.provider === providerId && m.id === preferred);
			if (match) return match;
		}
		return list.find((m) => m.provider === providerId);
	};
	return (
		pick(available) ??
		pick(all.filter((m) => ctx.modelRegistry.hasConfiguredAuth(m))) ??
		undefined
	);
}

async function resolveAuth(
	ctx: ExtensionContext,
	providerId: string,
): Promise<{ auth?: ResolvedAuth; error?: string }> {
	const model = findModel(ctx, providerId);
	if (!model) return { error: "not signed in" };
	const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!resolved.ok) return { error: resolved.error };
	return {
		auth: {
			isOAuth: ctx.modelRegistry.isUsingOAuth(model),
			apiKey: resolved.apiKey,
		},
	};
}

function decodeJwtPayload(token?: string): Record<string, unknown> | undefined {
	if (!token) return undefined;
	const parts = token.split(".");
	if (parts.length < 2) return undefined;
	try {
		return JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** ChatGPT account id: from the access-token JWT, else the stored credential. */
function codexAccountId(accessToken: string, providerId: string): string | undefined {
	const payload = decodeJwtPayload(accessToken);
	const auth = payload?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
	const fromJwt = auth?.chatgpt_account_id;
	if (typeof fromJwt === "string" && fromJwt) return fromJwt;
	try {
		const stored = readStoredCredential(providerId) as { accountId?: unknown } | undefined;
		return typeof stored?.accountId === "string" ? stored.accountId : undefined;
	} catch {
		return undefined;
	}
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

async function fetchJson(
	url: string,
	headers: Record<string, string>,
	signal?: AbortSignal,
): Promise<unknown> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const response = await fetch(url, { headers, signal: combined, redirect: "error" });
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
	}
	const text = await response.text();
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error("response was not JSON");
	}
}

function describeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/\b(401|403)\b|unauthorized|forbidden|invalid[_ ]token/i.test(message)) {
		return "sign-in expired";
	}
	if (/abort|timed? ?out/i.test(message)) return "timed out";
	if (/ENOTFOUND|ECONNREFUSED|fetch failed/i.test(message)) return "network unavailable";
	if (/^HTTP \d{3}/.test(message)) return message.replace(/HTTP (\d{3}).*/, "HTTP $1");
	if (/was not JSON/i.test(message)) return "unexpected response";
	return "unavailable";
}

/* ------------------------------------------------------------------ */
/* Provider queries                                                    */
/* ------------------------------------------------------------------ */

function clampPercent(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.min(100, Math.max(0, value));
}

function epochMs(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function opencodeWindow(raw: unknown, label: string): UsageWindow | undefined {
	const w = raw as { status?: unknown; percent?: unknown; resetsAt?: unknown } | undefined;
	if (!w || (typeof w.status === "string" && w.status !== "ok")) return undefined;
	const usedPercent = clampPercent(w.percent);
	if (usedPercent === undefined) return undefined;
	return { label, usedPercent, resetsAt: epochMs(w.resetsAt) };
}

function codexWindow(raw: unknown, label: string): UsageWindow | undefined {
	const w = raw as { used_percent?: unknown; reset_at?: unknown } | undefined;
	const usedPercent = clampPercent(w?.used_percent);
	if (usedPercent === undefined) return undefined;
	const resetAt = epochMs(w?.reset_at);
	return { label, usedPercent, resetsAt: resetAt === undefined ? undefined : resetAt * 1000 };
}

function anthropicWindow(raw: unknown, label: string): UsageWindow | undefined {
	const w = raw as { utilization?: unknown; resets_at?: unknown } | undefined;
	const usedPercent = clampPercent(w?.utilization);
	if (usedPercent === undefined) return undefined;
	return { label, usedPercent, resetsAt: epochMs(w?.resets_at) };
}

function planLabel(raw: unknown): string | undefined {
	if (typeof raw !== "string" || !raw) return undefined;
	const known: Record<string, string> = {
		free: "Free",
		plus: "Plus",
		pro: "Pro",
		max: "Max",
		team: "Team",
		business: "Business",
		enterprise: "Enterprise",
		edu: "Edu",
	};
	return known[raw.toLowerCase()] ?? raw;
}

function requireKey(auth: ResolvedAuth | undefined): string | undefined {
	return auth?.apiKey && auth.apiKey.length > 0 ? auth.apiKey : undefined;
}

async function fetchOpenCodeGo(ctx: ExtensionContext, signal?: AbortSignal): Promise<ProviderReport> {
	const report: ProviderReport = { id: "opencode-go", name: "OpenCode Go", windows: [] };
	const { auth, error } = await resolveAuth(ctx, "opencode-go");
	if (!auth) return { ...report, error };
	const key = requireKey(auth);
	if (!key) return { ...report, error: "no credential" };
	try {
		const data = (await fetchJson(
			OPENCODE_GO_URL,
			{
				Accept: "application/json",
				Authorization: `Bearer ${key}`,
				"User-Agent": USER_AGENT,
			},
			signal,
		)) as { usage?: Record<string, unknown> } | undefined;
		const usage = data?.usage ?? {};
		const windows = [
			opencodeWindow(usage.rolling, "5h"),
			opencodeWindow(usage.weekly, "7d"),
			opencodeWindow(usage.monthly, "30d"),
		].filter((w): w is UsageWindow => w !== undefined);
		return {
			...report,
			plan: "Go",
			windows,
			error: windows.length > 0 ? undefined : "no usage data",
		};
	} catch (err) {
		return { ...report, error: describeError(err) };
	}
}

async function fetchOpenAI(ctx: ExtensionContext, signal?: AbortSignal): Promise<ProviderReport> {
	const fallback: ProviderReport = { id: "openai-codex", name: "OpenAI (ChatGPT)", windows: [] };
	let providerId = "openai-codex";
	let { auth, error } = await resolveAuth(ctx, providerId);
	if (!auth) {
		providerId = "openai";
		({ auth, error } = await resolveAuth(ctx, providerId));
	}
	if (!auth) return { ...fallback, error };
	if (!auth.isOAuth) return { ...fallback, error: "API key (no subscription usage)" };
	const accessToken = requireKey(auth);
	if (!accessToken) return { ...fallback, error: "no credential" };

	const headers: Record<string, string> = {
		Accept: "application/json",
		Authorization: `Bearer ${accessToken}`,
		"User-Agent": USER_AGENT,
	};
	const accountId = codexAccountId(accessToken, providerId);
	if (accountId) headers["ChatGPT-Account-Id"] = accountId;

	try {
		const data = (await fetchJson(CODEX_URL, headers, signal)) as
			| {
					email?: unknown;
					plan_type?: unknown;
					rate_limit?: { primary_window?: unknown; secondary_window?: unknown };
			  }
			| undefined;
		const rateLimit = data?.rate_limit ?? {};
		const windows = [
			codexWindow(rateLimit.primary_window, "5h"),
			codexWindow(rateLimit.secondary_window, "7d"),
		].filter((w): w is UsageWindow => w !== undefined);
		return {
			...fallback,
			account: typeof data?.email === "string" ? data.email : undefined,
			plan: planLabel(data?.plan_type),
			windows,
			error: windows.length > 0 ? undefined : "no usage data",
		};
	} catch (err) {
		return { ...fallback, error: describeError(err) };
	}
}

async function fetchAnthropic(ctx: ExtensionContext, signal?: AbortSignal): Promise<ProviderReport> {
	const report: ProviderReport = { id: "anthropic", name: "Claude", windows: [] };
	const { auth, error } = await resolveAuth(ctx, "anthropic");
	if (!auth) return { ...report, error };
	if (!auth.isOAuth) return { ...report, error: "API key (no subscription usage)" };
	const accessToken = requireKey(auth);
	if (!accessToken) return { ...report, error: "no credential" };
	try {
		const data = (await fetchJson(
			ANTHROPIC_URL,
			{
				Accept: "application/json",
				Authorization: `Bearer ${accessToken}`,
				"anthropic-beta": ANTHROPIC_BETA,
				"User-Agent": USER_AGENT,
			},
			signal,
		)) as { five_hour?: unknown; seven_day?: unknown; plan_type?: unknown } | undefined;
		const windows = [
			anthropicWindow(data?.five_hour, "5h"),
			anthropicWindow(data?.seven_day, "7d"),
		].filter((w): w is UsageWindow => w !== undefined);
		return {
			...report,
			plan: planLabel(data?.plan_type),
			windows,
			error: windows.length > 0 ? undefined : "no usage data",
		};
	} catch (err) {
		return { ...report, error: describeError(err) };
	}
}

/* ------------------------------------------------------------------ */
/* Fetch orchestration and cache                                       */
/* ------------------------------------------------------------------ */

const cache = new Map<string, { at: number; report: ProviderReport }>();

const PROVIDERS: ReadonlyArray<{
	id: string;
	run: (ctx: ExtensionContext, signal?: AbortSignal) => Promise<ProviderReport>;
}> = [
	{ id: "opencode-go", run: fetchOpenCodeGo },
	{ id: "openai-codex", run: fetchOpenAI },
	{ id: "anthropic", run: fetchAnthropic },
];

async function fetchAll(
	ctx: ExtensionContext,
	force: boolean,
	signal?: AbortSignal,
): Promise<ProviderReport[]> {
	const settled = PROVIDERS.map(async ({ id, run }) => {
		const hit = cache.get(id);
		if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.report;
		const report = await run(ctx, signal);
		cache.set(id, { at: Date.now(), report });
		return report;
	});
	return Promise.all(settled);
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

function formatDuration(ms: number): string {
	if (ms <= 0) return "now";
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(ms / 3_600_000);
	if (hours < 24) return `${hours}h`;
	return `${Math.round(ms / 86_400_000)}d`;
}

function resetSuffix(resetsAt?: number): string {
	if (resetsAt === undefined) return "";
	return `  resets in ${formatDuration(resetsAt - Date.now())}`;
}

function shortName(id: string): string {
	if (id === "opencode-go") return "Go";
	if (id === "anthropic") return "Claude";
	return "Codex";
}

function usageBar(theme: Theme, usedPercent: number, width = 12): string {
	const filled = Math.round((usedPercent / 100) * width);
	const color = usedPercent >= 85 ? "error" : usedPercent >= 60 ? "warning" : "success";
	const on = theme.fg(color, "█".repeat(filled));
	const off = theme.fg("dim", "░".repeat(Math.max(0, width - filled)));
	return on + off;
}

function updateStatus(ctx: ExtensionContext, reports: ProviderReport[]): void {
	if (!ctx.hasUI) return;
	const parts: string[] = [];
	for (const report of reports) {
		if (report.error && report.windows.length === 0) continue;
		const primary = report.windows[0];
		if (!primary) continue;
		parts.push(`${shortName(report.id)} ${primary.label} ${Math.round(primary.usedPercent)}%`);
	}
	ctx.ui.setStatus(STATUS_KEY, parts.length > 0 ? parts.join(" · ") : undefined);
}

function plainReport(reports: ProviderReport[]): string {
	const lines: string[] = [];
	for (const report of reports) {
		const heading = report.plan ? `${report.name} · ${report.plan}` : report.name;
		lines.push(heading);
		if (report.windows.length === 0) {
			lines.push(`  ${report.error ?? "no usage data"}`);
			continue;
		}
		for (const window of report.windows) {
			lines.push(`  ${window.label}: ${Math.round(window.usedPercent)}% used${resetSuffix(window.resetsAt)}`);
		}
	}
	return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export class UsagePanel implements Focusable {
	focused = false;

	invalidate(): void {
		// The panel renders from current state on every call; no cache to clear.
	}

	private loading = true;
	private reports: ProviderReport[] = [];
	private failure?: string;

	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: () => void;
	private readonly load: (force: boolean) => Promise<ProviderReport[]>;

	constructor(
		tui: TUI,
		theme: Theme,
		done: () => void,
		load: (force: boolean) => Promise<ProviderReport[]>,
	) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.load = load;
		void this.refresh(false);
	}

	private async refresh(force: boolean): Promise<void> {
		this.loading = true;
		this.failure = undefined;
		this.tui.requestRender();
		try {
			this.reports = await this.load(force);
		} catch (error) {
			this.failure = error instanceof Error ? error.message : String(error);
		}
		this.loading = false;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.done();
			return;
		}
		if (data === "r" && !this.loading) void this.refresh(true);
	}

	render(width: number): string[] {
		const theme = this.theme;
		const boxWidth = Math.max(30, Math.min(width, 76));
		const inner = boxWidth - 2;
		const lines: string[] = [];
		const row = (content: string) => {
			const padded = content + " ".repeat(Math.max(0, inner - visibleWidth(content)));
			return theme.fg("border", "│") + truncateToWidth(padded, inner, "", false) + theme.fg("border", "│");
		};

		const title = " Subscription usage ";
		const fill = Math.max(0, inner - visibleWidth(title) - 1);
		lines.push(theme.fg("border", "╭─") + theme.fg("accent", title) + theme.fg("border", `${"─".repeat(fill)}╮`));
		lines.push(row(""));

		if (this.loading && this.reports.length === 0) {
			lines.push(row(" " + theme.fg("dim", "Loading usage…")));
		} else {
			for (const report of this.reports) {
				let head = " " + theme.fg("accent", report.name);
				if (report.plan) head += theme.fg("dim", ` · ${report.plan}`);
				if (report.account) head += theme.fg("dim", ` · ${report.account}`);
				lines.push(row(head));
				if (report.windows.length === 0) {
					lines.push(row("   " + theme.fg("warning", report.error ?? "no usage data")));
				} else {
					for (const window of report.windows) {
						const label = theme.fg("text", window.label.padStart(3));
						const percent = theme.fg("text", `${Math.round(window.usedPercent)}%`.padStart(4));
						lines.push(
							row(
								`   ${label}  ${usageBar(theme, window.usedPercent)} ${percent}` +
									theme.fg("dim", resetSuffix(window.resetsAt)),
							),
						);
					}
				}
				lines.push(row(""));
			}
		}

		if (this.failure) lines.push(row(" " + theme.fg("error", this.failure)));
		lines.push(row(theme.fg("dim", " r refresh · q/esc close ")));
		lines.push(theme.fg("border", `╰${"─".repeat(inner)}╯`));
		return lines;
	}
}

/* ------------------------------------------------------------------ */
/* Extension                                                           */
/* ------------------------------------------------------------------ */

export default function usageExtension(pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;

	const refreshStatus = async (ctx: ExtensionContext, force: boolean): Promise<void> => {
		try {
			const reports = await fetchAll(ctx, force, ctx.signal);
			updateStatus(ctx, reports);
		} catch {
			// Status is best-effort. Keep the previous value on failure.
		}
	};

	pi.registerCommand("usage", {
		description: "Show subscription usage (opencode-go, OpenAI, Claude)",
		handler: async (_args, ctx) => {
			if (ctx.mode === "tui") {
				await ctx.ui.custom<undefined>(
					(tui, theme, _keybindings, done) =>
						new UsagePanel(tui, theme, () => done(undefined), async (force) => {
							const reports = await fetchAll(ctx, force, ctx.signal);
							updateStatus(ctx, reports);
							return reports;
						}),
					{
						overlay: true,
						overlayOptions: { anchor: "center", width: 76, maxHeight: "90%", margin: 1 },
					},
				);
				return;
			}
			const reports = await fetchAll(ctx, true, ctx.signal);
			updateStatus(ctx, reports);
			ctx.ui.notify(plainReport(reports), "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		void refreshStatus(ctx, false);
		timer = setInterval(() => {
			void refreshStatus(ctx, false);
		}, STATUS_REFRESH_MS);
		timer.unref?.();
	});

	pi.on("session_shutdown", () => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	});
}
