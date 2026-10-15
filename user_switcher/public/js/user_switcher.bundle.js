// Floating quick user switcher. Loaded on both Desk (app_include_js) and website
// pages (web_include_js), so it only relies on jQuery + frappe.call, which exist in both.
(function () {
	const API = "user_switcher.api";
	const CACHE_KEY = "user_switcher_allowed";
	const HIDDEN_KEY = "user_switcher_hidden";
	const BANNER_KEY = "user_switcher_banner_collapsed";
	const USAGE_KEY = "user_switcher_usage";
	const PINS_KEY = "user_switcher_pins";
	const LEGACY_RECENT_KEY = "user_switcher_recent";
	const MAX_MOST_USED = 5;
	// Ctrl+S is Frappe's Save, so the switcher uses Ctrl+Shift+S
	const SHORTCUT_LABEL = "Ctrl+Shift+S";
	const is_open_shortcut = (e) => (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyS";
	// Straight back to the account you logged in with (Administrator, usually), from any page
	const BACK_SHORTCUT_LABEL = "Ctrl+Shift+A";
	const is_back_shortcut = (e) => (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyA";

	const ICONS = {
		swap: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4 3 8l4 4"/><path d="M3 8h14"/><path d="m17 20 4-4-4-4"/><path d="M21 16H7"/></svg>`,
		search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
		back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>`,
		close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
		enter: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 4v7a4 4 0 0 1-4 4H4"/><path d="m9 10-5 5 5 5"/></svg>`,
		star: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>`,
		plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
		grip: `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>`,
		chevron_right: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`,
		chevron_left: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>`,
		shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/></svg>`,
		info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.5h.01"/></svg>`,
		eye: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`,
	};

	// ---------- helpers ----------

	function on_ready(fn) {
		if (document.readyState === "loading") {
			document.addEventListener("DOMContentLoaded", fn);
		} else {
			fn();
		}
	}

	function current_user() {
		return (frappe.session && frappe.session.user) || frappe.get_cookie?.("user_id") || "Guest";
	}

	function t(msg, args) {
		return window.__ ? __(msg, args) : msg.replace(/\{(\d+)\}/g, (_, i) => args[i]);
	}

	function esc(s) {
		return frappe.utils?.escape_html ? frappe.utils.escape_html(s || "") : $("<div>").text(s || "").html();
	}

	function storage(store, key, value) {
		try {
			if (value === undefined) return store.getItem(key);
			if (value === null) store.removeItem(key);
			else store.setItem(key, value);
		} catch (e) {}
		return null;
	}

	function read_json(store, key, fallback) {
		try {
			return JSON.parse(storage(store, key) || "null") ?? fallback;
		} catch (e) {
			return fallback;
		}
	}

	function hue(str) {
		let h = 0;
		for (const ch of str || "") h = (h * 31 + ch.charCodeAt(0)) % 360;
		return h;
	}

	function initials(u) {
		const label = u.full_name || u.name || "?";
		const parts = label
			.replace(/([a-z])([A-Z])/g, "$1 $2") // "JaneSmith" -> "Jane Smith"
			.split(/[\s@._-]+/)
			.filter(Boolean);
		return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "?";
	}

	function avatar(u, cls = "") {
		// Initials sit underneath; a broken image removes itself and reveals them
		const img = u.user_image ? `<img src="${esc(u.user_image)}" alt="" onerror="this.remove()">` : "";
		return `<span class="us-avatar ${cls}" style="--us-hue:${hue(u.name)}">${esc(initials(u))}${img}</span>`;
	}

	function display_name(u) {
		return u?.full_name || u?.name || "";
	}

	function slug(s) {
		return (s || "")
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[^\w\s.-]/g, "")
			.trim()
			.replace(/[\s_]+/g, ".");
	}

	// ---------- identity (known before any API call) ----------

	const who = {
		// The account that actually logged in; usage + pins are stored per real user.
		real: frappe.boot?.user?.impersonated_by || current_user(),
		is_switched: !!frappe.boot?.user?.impersonated_by,
	};

	function boot_user_info(name) {
		const info = frappe.user_info?.(name);
		return { name, full_name: info?.fullname || name, user_image: info?.image || null };
	}

	// ---------- usage + pins (per real user, in this browser) ----------

	const store = {
		usage_key: () => `${USAGE_KEY}:${who.real}`,
		pins_key: () => `${PINS_KEY}:${who.real}`,

		// { [user]: { count, last, info } }
		usage() {
			const usage = read_json(localStorage, this.usage_key(), null);
			if (usage) return usage;
			// Seed from the old "recent" list so existing history isn't lost
			const legacy = read_json(localStorage, `${LEGACY_RECENT_KEY}:${who.real}`, []);
			return Object.fromEntries(legacy.map((info, i) => [info.name, { count: 1, last: -i, info }]));
		},

		remember(u) {
			if (!u?.name || u.name === who.real) return;
			const usage = this.usage();
			usage[u.name] = { count: (usage[u.name]?.count || 0) + 1, last: Date.now(), info: slim(u, usage[u.name]?.info) };
			storage(localStorage, this.usage_key(), JSON.stringify(usage));
		},

		// [info, ...] in the order they were pinned
		pins() {
			return read_json(localStorage, this.pins_key(), []);
		},

		is_pinned(name) {
			return this.pins().some((p) => p.name === name);
		},

		// Save the new order of the pins that are on screen; pins hidden by the current filter keep their slots
		reorder_pins(names) {
			const pins = this.pins();
			const by_name = Object.fromEntries(pins.map((p) => [p.name, p]));
			const queue = names.filter((n) => by_name[n]);
			const shown = new Set(queue);
			const ordered = pins.map((p) => (shown.has(p.name) ? by_name[queue.shift()] : p));
			storage(localStorage, this.pins_key(), JSON.stringify(ordered));
		},

		toggle_pin(u) {
			let pins = this.pins();
			if (pins.some((p) => p.name === u.name)) pins = pins.filter((p) => p.name !== u.name);
			else pins.push(slim(u));
			storage(localStorage, this.pins_key(), JSON.stringify(pins));
		},
	};

	function slim(u, fallback = {}) {
		const pick = (k) => u[k] ?? fallback[k] ?? null;
		return {
			name: u.name,
			full_name: pick("full_name"),
			user_image: pick("user_image"),
			user_type: pick("user_type"),
			roles: pick("roles") || [],
		};
	}

	// ---------- switching (shared by the widget and the banner) ----------

	function switch_to(user, { back = false } = {}) {
		$("#us-floating-container").removeClass("us-open").addClass("us-busy");
		frappe.dom?.freeze?.(t("Switching to {0}...", [esc(display_name(user))]));
		return frappe
			.call({
				method: back ? `${API}.switch_back` : `${API}.switch_to_user`,
				args: back ? {} : { target_user: user.name },
				type: "POST",
			})
			.then(() => {
				if (!back) store.remember(user);
				// sessionStorage caches are per-user; drop them before the new user's page loads
				try {
					Object.keys(sessionStorage)
						.filter((k) => k.startsWith(CACHE_KEY) || k.startsWith(BANNER_KEY))
						.forEach((k) => sessionStorage.removeItem(k));
				} catch (e) {}
				// The current desk route may not be accessible to the new user, so restart from /app
				if (window.location.pathname.startsWith("/app")) window.location.href = "/app";
				else window.location.reload();
			})
			.catch(() => {
				$("#us-floating-container").removeClass("us-busy");
				frappe.dom?.unfreeze?.();
			});
	}

	function switch_back() {
		return switch_to({ name: who.real, full_name: who.real_full_name || who.real }, { back: true });
	}

	// ---------- "you are switched" banner ----------

	function render_banner(me, real) {
		$("#us-banner").remove();
		if (!who.is_switched) return;

		const collapsed = storage(sessionStorage, BANNER_KEY) === "1";
		const $banner = $(`
			<div id="us-banner" class="${collapsed ? "us-banner--collapsed" : ""}" role="status">
				<div class="us-banner-frame"></div>
				<div class="us-banner-pill">
					<span class="us-banner-icon">${ICONS.eye}</span>
					<span class="us-banner-text">${t("Viewing as {0}", [`<b>${esc(display_name(me))}</b>`])}</span>
					<button class="us-banner-back" title="${t("Switch back ({0})", [BACK_SHORTCUT_LABEL])}">
						${ICONS.back}<span>${t("Back to {0}", [esc(display_name(real))])}</span>
					</button>
					<button class="us-banner-collapse" title="${t("Collapse")}" aria-label="${t("Collapse")}">${ICONS.close}</button>
				</div>
			</div>
		`).appendTo("body");

		$banner.find(".us-banner-back").on("click", switch_back);
		$banner.find(".us-banner-collapse").on("click", (e) => {
			e.stopPropagation();
			$banner.addClass("us-banner--collapsed");
			storage(sessionStorage, BANNER_KEY, "1");
		});
		// Collapsed, it's just the icon; click to expand again
		$banner.find(".us-banner-pill").on("click", () => {
			if (!$banner.hasClass("us-banner--collapsed")) return;
			$banner.removeClass("us-banner--collapsed");
			storage(sessionStorage, BANNER_KEY, null);
		});
	}

	// ---------- permission probe ----------

	// Decide whether to show the button without hitting the server on every page load.
	function check_allowed() {
		if (frappe.boot && "user_switcher_allowed" in frappe.boot) {
			return Promise.resolve(!!frappe.boot.user_switcher_allowed);
		}
		const key = `${CACHE_KEY}:${current_user()}`;
		const cached = storage(sessionStorage, key);
		if (cached !== null) return Promise.resolve(cached === "1");

		return frappe
			.call({ method: `${API}.get_context`, args: { limit: 0 }, type: "GET" })
			.then((r) => {
				const allowed = !!r.message?.allowed;
				storage(sessionStorage, key, allowed ? "1" : "0");
				return allowed;
			})
			.catch(() => false);
	}

	// ---------- the widget ----------

	// ---------- "How to use" guide (shown from the (i) button next to Hide) ----------

	function info_html() {
		const kbd = (k) => `<kbd>${k}</kbd>`;
		const item = (icon, title, text) =>
			`<div class="us-info-item"><span class="us-info-icon">${ICONS[icon]}</span><div><b>${title}</b><p>${text}</p></div></div>`;
		return `
			<p class="us-info-lead">${t("See the app exactly as another user sees it. Pick a user and you are logged in as them. Go back anytime with one click.")}</p>
			${item("swap", t("Switch to a user"), t("Click a user, or press its number {0} to {1}. Type in the search box to find someone by name or email.", [kbd(1), kbd(9)]))}
			${item("back", t("Come back to your own account"), t("Press {0}, click “Back to …” at the top, or press {1} on any page.", [kbd(0), kbd(BACK_SHORTCUT_LABEL)]))}
			${item("star", t("Pinned users"), t("Click the star on a user to pin them at the top. Pinned users keep their numbers, even after you switch. Drag a pinned user up or down to change the order. Users you switch to often also show under Most used."))}
			${item("shield", t("Manage roles"), t("Click Manage roles at the top to give or remove roles (access) for the user you are viewing as. Tick the roles, then press Save roles."))}
			${item("plus", t("Create a test user"), t("Click + Test user, type a name, tick the roles and create. You can switch into the new user right away."))}
			${item("eye", t("Hide the button"), t("Click Hide to remove the button until your next login. Press {0} to bring it back.", [kbd(SHORTCUT_LABEL)]))}
			<div class="us-info-keys">
				<span>${kbd(SHORTCUT_LABEL)} ${t("open or close")}</span>
				<span>${kbd("↑")}${kbd("↓")}${kbd("↵")} ${t("move and pick")}</span>
				<span>${kbd("Esc")} ${t("close")}</span>
			</div>
			${item("info", t("Good to know"), t("It works only when developer mode and user_switcher_enabled are both on. Every switch is saved in the User Switch Log. Do not use it on a live site."))}
		`;
	}

	function render_widget() {
		if ($("#us-floating-container").length) return;

		const $root = $(`
			<div id="us-floating-container" role="region" aria-label="${t("User Switcher")}">
				<div class="us-card" role="dialog" aria-label="${t("Switch user")}" aria-hidden="true">
					<div class="us-identity"></div>

					<div class="us-browse">
						<div class="us-search">
							<span class="us-search-icon">${ICONS.search}</span>
							<input type="text" placeholder="${t("Search name or email")}" autocomplete="off" spellcheck="false">
							<kbd class="us-kbd">${SHORTCUT_LABEL}</kbd>
						</div>
						<div class="us-filters" role="tablist">
							<button class="us-filter active" data-type="">${t("All")}</button>
							<button class="us-filter" data-type="System User">${t("System")}</button>
							<button class="us-filter" data-type="Website User">${t("Website")}</button>
							<button class="us-new" title="${t("Create a test user")}">${ICONS.plus}<span>${t("Test user")}</span></button>
						</div>
						<div class="us-list" role="listbox"></div>
					</div>

					<form class="us-create" autocomplete="off" novalidate>
						<div class="us-create-head">
							<button type="button" class="us-icon-btn us-create-cancel" aria-label="${t("Back")}">${ICONS.chevron_left}</button>
							<span class="us-create-titles">
								<span class="us-create-title">${t("New test user")}</span>
								<span class="us-create-sub"></span>
							</span>
						</div>
						<p class="us-roles-intro">${t("Tick the roles this user should have. Unticked roles are removed when you save.")}</p>
						<label class="us-field us-create-fields">
							<span>${t("Full name")}</span>
							<input name="full_name" type="text" placeholder="${t("e.g. Priya Accounts")}" required>
						</label>
						<label class="us-field us-create-fields">
							<span>${t("Email")}</span>
							<input name="email" type="email" placeholder="priya.accounts@example.com" required>
						</label>
						<div class="us-field">
							<span class="us-field-row">
								<span>${t("Roles")} <span class="us-picked-count"></span></span>
								<span class="us-type-hint"></span>
							</span>
							<input class="us-role-search" type="text" placeholder="${t("Filter roles")}">
								<div class="us-role-list"><div class="us-empty">${t("Loading roles...")}</div></div>
						</div>
						<div class="us-create-actions">
							<button type="button" class="us-btn us-create-only">${t("Create")}</button>
							<button type="submit" class="us-btn us-btn--primary">${t("Create & switch")}</button>
							<button type="button" class="us-btn us-roles-cancel">${t("Cancel")}</button>
							<button type="button" class="us-btn us-btn--primary us-roles-save">${t("Save roles")}</button>
						</div>
					</form>

					<div class="us-info">
						<div class="us-create-head">
							<button type="button" class="us-icon-btn us-info-back" aria-label="${t("Back")}">${ICONS.chevron_left}</button>
							<span class="us-create-titles"><span class="us-create-title">${t("How to use User Switcher")}</span></span>
						</div>
						${info_html()}
					</div>

					<div class="us-footer">
						<span class="us-hints">
							<span><kbd>1</kbd>–<kbd>9</kbd> ${t("switch")}</span>
							<span class="us-hint-back" title="${t("{0} from any page", [BACK_SHORTCUT_LABEL])}"><kbd>0</kbd> ${t("back")}</span>
							<span><kbd>↑</kbd><kbd>↓</kbd><kbd>↵</kbd></span>
						</span>
						<span class="us-footer-actions">
							<button class="us-info-btn" title="${t("How to use")}" aria-label="${t("How to use")}" aria-pressed="false">${ICONS.info}</button>
							<button class="us-hide" title="${t("Hide until next session ({0} to reopen)", [SHORTCUT_LABEL])}">${t("Hide")}</button>
						</span>
					</div>
				</div>
				<button class="us-trigger" aria-label="${t("Switch user")}" aria-expanded="false">
					<span class="us-trigger-avatar"></span>
					<span class="us-trigger-label"></span>
					<span class="us-trigger-badge">${ICONS.swap}</span>
				</button>
			</div>
		`).appendTo("body");

		const $card = $root.find(".us-card");
		const $trigger = $root.find(".us-trigger");
		const $list = $root.find(".us-list");
		const $identity = $root.find(".us-identity");
		const $search = $root.find(".us-search input");
		const $create = $root.find(".us-create");
		const state = { ctx: null, user_type: "", txt: "", request_id: 0, creating: false, info: false, editing: null, roles: null, picked: new Set() };
		let search_timer;

		if (storage(sessionStorage, HIDDEN_KEY) === "1") $root.addClass("us-hidden");

		// Paint the trigger straight away from what we already know, then refine once loaded.
		paint_trigger({ current_user: boot_user_info(current_user()), is_switched: who.is_switched });
		// Website pages have no boot info to tell us if we're switched, so ask once up front
		if (!frappe.boot?.user) fetch_users();

		const is_open = () => $root.hasClass("us-open");

		function open() {
			$root.removeClass("us-hidden").addClass("us-open");
			storage(sessionStorage, HIDDEN_KEY, null);
			$card.attr("aria-hidden", "false");
			$trigger.attr("aria-expanded", "true");
			fetch_users();
			if (!state.creating) setTimeout(() => $search.trigger("focus").trigger("select"), 60);
		}

		function show_info(on) {
			if (on && state.creating) show_create(false);
			state.info = on;
			$root.toggleClass("us-info-mode", on);
			$root.find(".us-info-btn").toggleClass("is-on", on).attr("aria-pressed", on);
			if (on) $root.find(".us-info").scrollTop(0);
			else $search.trigger("focus");
		}

		$root.find(".us-info-btn").on("click", () => show_info(!state.info));
		$root.find(".us-info-back").on("click", () => show_info(false));

		function close() {
			state.info = false;
			$root.removeClass("us-open us-info-mode").find(".us-info-btn").removeClass("is-on").attr("aria-pressed", false);
			$card.attr("aria-hidden", "true");
			$trigger.attr("aria-expanded", "false");
		}

		$trigger.on("click", (e) => {
			e.stopPropagation();
			is_open() ? close() : open();
		});

		$root.find(".us-hide").on("click", () => {
			close();
			$root.addClass("us-hidden");
			storage(sessionStorage, HIDDEN_KEY, "1");
			frappe.show_alert?.({
				message: t("User Switcher hidden. Press {0} to bring it back.", [SHORTCUT_LABEL]),
				indicator: "blue",
			});
		});

		$(document).on("click.user_switcher", (e) => {
			if (is_open() && !$(e.target).closest("#us-floating-container").length) close();
		});

		$(document).on("keydown.user_switcher", (e) => {
			if (is_open_shortcut(e)) {
				e.preventDefault();
				e.stopPropagation();
				is_open() ? close() : open();
				return;
			}
			if (!is_open()) return;

			if (e.key === "Escape") {
				if (state.info) show_info(false);
				else if (state.creating) show_create(false);
				else {
					close();
					$trigger.trigger("focus");
				}
				return;
			}
			if (state.creating || state.info) return; // let the form have every other key

			// 1-9 switch to the numbered user, 0 goes back. Only while the search box is
			// empty, so digits can still be typed to search once a query is started.
			const digit = /^Digit(\d)$/.exec(e.code)?.[1] ?? (/^\d$/.test(e.key) ? e.key : null);
			if (digit !== null && !e.ctrlKey && !e.metaKey && !e.altKey && !$search.val()) {
				e.preventDefault();
				if (digit === "0") {
					if (who.is_switched) switch_back();
				} else {
					$list.find(`.us-item[data-index="${digit}"]`).trigger("click");
				}
				return;
			}

			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				move_active(e.key === "ArrowDown" ? 1 : -1);
			} else if (e.key === "Enter" && $(e.target).is($search)) {
				e.preventDefault();
				$list.find(".us-item.is-active").trigger("click");
			}
		});

		$search.on("input", () => {
			clearTimeout(search_timer);
			search_timer = setTimeout(() => {
				state.txt = $search.val().trim();
				fetch_users();
			}, 200);
		});

		$root.find(".us-filter").on("click", function () {
			$root.find(".us-filter").removeClass("active");
			$(this).addClass("active");
			state.user_type = $(this).data("type") || "";
			fetch_users();
			$search.trigger("focus");
		});

		// ---------- drag to reorder pinned users ----------

		// Rows swap live while you drag: note where every pinned row is (FLIP), move the dragged row
		// in the DOM, then slide each row from its old spot to the new one. The order is saved on drop;
		// releasing outside the list cancels and puts everything back.
		const reduced_motion = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
		const pinned_rows = () => $list.find(".us-item[draggable=true]").toArray();

		function renumber(rows) {
			rows.forEach((row, i) => {
				row.dataset.index = i + 1;
				const $num = $(row).find("kbd.us-num");
				if (i < 9) $num.text(i + 1);
			});
		}

		function move_dragged(client_y) {
			const rows = pinned_rows();
			const dragged = rows.find((r) => r.dataset.name === state.drag_name);
			if (!dragged) return;

			// Layout offsets ignore in-flight slide transforms, so a row mid-slide can't flip the choice back
			const y = client_y - $list[0].getBoundingClientRect().top + $list[0].scrollTop;
			const others = rows.filter((r) => r !== dragged);
			const before = others.find((r) => y < r.offsetTop + r.offsetHeight / 2);
			const last = others[others.length - 1];
			if (before ? dragged.nextElementSibling === before : !last || last.nextElementSibling === dragged) return;

			const first_top = new Map(rows.map((r) => [r, r.getBoundingClientRect().top]));
			before ? before.before(dragged) : last.after(dragged);

			rows.forEach((r) => r.getAnimations().forEach((a) => a.id === "us-swap" && a.cancel()));
			const after_rows = pinned_rows();
			renumber(after_rows);
			if (reduced_motion) return;
			after_rows.forEach((r) => {
				const dy = first_top.get(r) - r.getBoundingClientRect().top;
				if (!dy) return;
				r.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
					id: "us-swap",
					duration: 240,
					easing: "cubic-bezier(0.2, 0.9, 0.3, 1)",
				});
			});
		}

		function finish_drag() {
			const moved = state.drag_name;
			const names = pinned_rows().map((r) => r.dataset.name);
			if (state.dropped) store.reorder_pins(names);
			const saved = state.dropped;
			state.drag_name = null;
			state.dropped = false;
			paint_list(); // rebuilds rows from the saved order (or the old one, if cancelled)
			if (saved) {
				$list.find(`.us-item[data-name="${CSS.escape(moved)}"]`)
					.addClass("us-settled")
					.one("animationend", function () {
						$(this).removeClass("us-settled");
					});
			}
		}

		// The whole card accepts the drag, and dragenter must be accepted too: the browser picks the
		// cursor from dragenter, so accepting only dragover on the list flashes the red "no drop" sign
		// every time the pointer crosses into another element (or sits over the search box, header, footer).
		// Releasing outside the card still cancels.
		$card
			.on("dragenter dragover", (e) => {
				if (!state.drag_name) return;
				e.preventDefault();
				e.originalEvent.dataTransfer.dropEffect = "move";
				if (e.type === "dragover") move_dragged(e.originalEvent.clientY);
			})
			.on("drop", (e) => {
				if (!state.drag_name) return;
				e.preventDefault();
				move_dragged(e.originalEvent.clientY); // settle exactly where the pointer was released
				state.dropped = true;
			});

		function fetch_users() {
			const request_id = ++state.request_id;
			if (!state.ctx) $list.html(skeleton());

			return frappe
				.call({
					method: `${API}.get_context`,
					args: { txt: state.txt, user_type: state.user_type },
					type: "GET",
				})
				.then((r) => {
					if (request_id !== state.request_id) return; // a newer search is in flight
					const ctx = r.message || {};
					if (!ctx.allowed) {
						$list.html(empty_state(t("You are not permitted to switch users.")));
						return;
					}
					state.ctx = ctx;
					who.real = ctx.real_user.name;
					who.real_full_name = display_name(ctx.real_user);
					who.is_switched = !!ctx.is_switched;
					paint_trigger(ctx);
					paint_identity(ctx);
					paint_list();
					render_banner(ctx.current_user, ctx.real_user);
				});
		}

		function paint_trigger(ctx) {
			const me = ctx.current_user;
			$root.toggleClass("us-switched", !!ctx.is_switched);
			$trigger.find(".us-trigger-avatar").html(avatar(me, "us-avatar--lg"));
			$trigger
				.find(".us-trigger-label")
				.html(ctx.is_switched ? `${t("Viewing as")} <b>${esc(display_name(me))}</b>` : t("Switch user"));
		}

		function paint_identity(ctx) {
			const me = ctx.current_user;
			const real = ctx.real_user;
			$identity.html(`
				<div class="us-identity-main">
					${avatar(me, "us-avatar--lg")}
					<div class="us-identity-text">
						<span class="us-eyebrow">${ctx.is_switched ? t("Viewing as") : t("Signed in as")}</span>
						<span class="us-identity-name">${esc(display_name(me))}</span>
						<span class="us-identity-email">${esc(me.name)}</span>
					</div>
					<button class="us-icon-btn us-close" aria-label="${t("Close")}">${ICONS.close}</button>
				</div>
				${
					// Administrator's roles can't be edited (the server refuses), so don't offer it
					me.name === "Administrator"
						? ""
						: `<button class="us-edit-roles" title="${t("Give or remove roles (access) for this user")}">
							${ICONS.shield}
							<span class="us-edit-roles-text">
								<b>${t("Manage roles")}</b>
								<small>${t("Give or remove access for {0}", [esc(display_name(me))])}</small>
							</span>
							${ICONS.chevron_right}
						</button>`
				}
				${
					ctx.is_switched
						? `<button class="us-switch-back">
							${ICONS.back}
							<span>${t("Back to {0}", [`<b>${esc(display_name(real))}</b>`])}</span>
							<kbd class="us-back-key" title="${t("or {0} from any page", [BACK_SHORTCUT_LABEL])}">0</kbd>
						</button>`
						: ""
				}
			`);
			$identity.find(".us-close").on("click", close);
			$identity.find(".us-edit-roles").on("click", () => show_roles(me));
			$identity.find(".us-switch-back").on("click", switch_back);
		}

		// Pinned first (stable numbers), then most used, then everyone else.
		function paint_list() {
			const ctx = state.ctx;
			if (!ctx) return;
			const skip = new Set([ctx.current_user.name, ctx.real_user.name]);
			// Cached entries may be stale; prefer the live row where the server returned one
			const live = Object.fromEntries(ctx.users.map((u) => [u.name, u]));
			const fresh = (u) => live[u.name] || u;
			const matches_type = (u) => !state.user_type || u.user_type === state.user_type;

			let pinned = [];
			let most_used = [];
			if (!state.txt) {
				pinned = store
					.pins()
					.map(fresh)
					.filter(matches_type); // never skipped, even the user you are viewing as, so pinned numbers stay put
				const pinned_names = new Set(pinned.map((u) => u.name));
				most_used = Object.values(store.usage())
					.filter((e) => !skip.has(e.info.name) && !pinned_names.has(e.info.name))
					.map((e) => ({ ...e, info: fresh(e.info) }))
					.filter((e) => matches_type(e.info))
					.sort((a, b) => b.count - a.count || b.last - a.last)
					.slice(0, MAX_MOST_USED);
			}
			const shown = new Set([...pinned.map((u) => u.name), ...most_used.map((e) => e.info.name)]);
			const others = ctx.users.filter((u) => !shown.has(u.name));

			const active_name = $list.find(".us-item.is-active").data("name");
			$root.toggleClass("us-can-go-back", !!ctx.is_switched);
			$list.empty();

			if (!pinned.length && !most_used.length && !others.length) {
				$list.html(
					empty_state(state.txt ? t("No users match “{0}”", [esc(state.txt)]) : t("No other users found"))
				);
				return;
			}

			let index = 0;
			const section = (title, rows) => {
				if (!rows.length) return;
				if (pinned.length || most_used.length) $list.append(`<div class="us-group">${title}</div>`);
				rows.forEach(({ u, uses, drag }) =>
					$list.append(item(u, ++index, uses, drag, u.name === ctx.current_user.name))
				);
			};
			section(t("Pinned"), pinned.map((u) => ({ u, drag: pinned.length > 1 })));
			section(t("Most used"), most_used.map((e) => ({ u: e.info, uses: e.count })));
			section(t("All users"), others.map((u) => ({ u })));

			const $active = active_name ? $list.find(`.us-item[data-name="${CSS.escape(active_name)}"]`) : $();
			($active.length ? $active : $list.find(".us-item").first()).addClass("is-active");
		}

		function item(u, index, uses, drag, current) {
			const website = u.user_type === "Website User" ? `<span class="us-chip us-chip--web">${t("Website")}</span>` : "";
			const now = current ? `<span class="us-chip us-chip--current">${t("Current")}</span>` : "";
			const key = index <= 9 ? `<kbd class="us-num">${index}</kbd>` : `<span class="us-num us-num--none"></span>`;
			const pinned = store.is_pinned(u.name);
			const title = uses ? t("Switched {0} times", [uses]) : "";
			const $item = $(`
				<div class="us-item" role="option" tabindex="-1" title="${esc(title)}">
					${drag ? `<span class="us-grip" title="${t("Drag to reorder")}">${ICONS.grip}</span>` : `<span class="us-grip us-grip--off"></span>`}
					${key}
					${avatar(u)}
					<div class="us-item-text">
						<span class="us-item-name"><span class="us-item-name-text">${esc(display_name(u))}</span>${website}${now}</span>
						<span class="us-item-email">${esc(u.name)}</span>
					</div>
					<button class="us-pin ${pinned ? "is-pinned" : ""}" title="${pinned ? t("Unpin") : t("Pin to top")}"
						aria-label="${pinned ? t("Unpin") : t("Pin to top")}" aria-pressed="${pinned}">${ICONS.star}</button>
					<span class="us-enter">${ICONS.enter}</span>
				</div>
			`)
				.attr({ "data-index": index, "data-name": u.name })
				.on("mouseenter", function () {
					$list.find(".us-item").removeClass("is-active");
					$(this).addClass("is-active");
				})
				.toggleClass("us-item--current", !!current)
				// Already viewing as this user: nothing to switch, just keep its numbered slot
				.on("click", () => (current ? close() : switch_to(u)));

			$item.find(".us-pin").on("click", (e) => {
				e.stopPropagation();
				store.toggle_pin(u);
				paint_list();
			});

			if (drag) {
				$item
					.attr("draggable", "true")
					.on("dragstart", (e) => {
						state.drag_name = u.name;
						state.dropped = false;
						e.originalEvent.dataTransfer.effectAllowed = "move";
						e.originalEvent.dataTransfer.setData("text/plain", u.name);
						// A tick later, so the browser snapshots the normal-looking row as the drag image
						setTimeout(() => $item.addClass("is-dragging"));
					})
					.on("dragend", finish_drag);
			}
			return $item;
		}

		function move_active(step) {
			const $items = $list.find(".us-item");
			if (!$items.length) return;
			let idx = $items.index($items.filter(".is-active"));
			idx = (idx + step + $items.length) % $items.length;
			$items.removeClass("is-active");
			$items.eq(idx).addClass("is-active")[0].scrollIntoView({ block: "nearest" });
		}

		function skeleton() {
			return Array.from({ length: 4 })
				.map(
					() => `<div class="us-item us-skeleton">
						<span class="us-avatar"></span>
						<div class="us-item-text"><span class="us-bar"></span><span class="us-bar us-bar--short"></span></div>
					</div>`
				)
				.join("");
		}

		function empty_state(msg) {
			return `<div class="us-empty">${msg}</div>`;
		}

		// ---------- create test user ----------

		const $name = $create.find("[name=full_name]");
		const $email = $create.find("[name=email]");
		const $role_search = $create.find(".us-role-search");
		const $role_list = $create.find(".us-role-list");
		let email_touched = false;

		$root.find(".us-new").on("click", () => show_create(true));
		$create.find(".us-create-cancel").on("click", () => show_create(false));

		function show_create(on) {
			state.creating = on;
			state.editing = null;
			if (on && state.info) show_info(false);
			$root.toggleClass("us-creating", on).removeClass("us-roles-mode");
			$create.find(".us-create-title").text(t("New test user"));
			$create.find(".us-create-sub").text("");
			if (!on) {
				$search.trigger("focus");
				return;
			}
			const seed = state.txt && !state.txt.includes("@") ? state.txt : "";
			$create[0].reset();
			state.picked = new Set();
			email_touched = false;
			$name.val(seed).trigger("input");
			setTimeout(() => $name.trigger("focus"), 30);
			load_roles();
		}

		// ---------- manage roles of the signed-in user ----------

		function show_roles(user) {
			show_create(true);
			state.editing = user.name;
			state.original = new Set();
			$root.addClass("us-roles-mode");
			$create.find(".us-create-title").text(t("Manage roles"));
			$create.find(".us-create-sub").text(`${display_name(user)} · ${user.name}`);
			frappe.call({ method: `${API}.get_user_roles`, args: { user: user.name }, type: "GET" }).then((r) => {
				state.original = new Set(r.message || []);
				state.picked = new Set(state.original);
				load_roles();
			});
		}

		$create.find(".us-roles-cancel").on("click", () => show_create(false));

		$create.find(".us-roles-save").on("click", () => {
			const $buttons = $create.find(".us-btn").prop("disabled", true);
			frappe
				.call({
					method: `${API}.set_user_roles`,
					args: { user: state.editing, roles: [...state.picked] },
					type: "POST",
				})
				.then(() => {
					frappe.show_alert?.({ message: t("Roles updated"), indicator: "green" });
					// Desk caches the user's roles in boot info, so reload to apply them
					window.location.reload();
				})
				.catch(() => $buttons.prop("disabled", false));
		});

		$name.on("input", () => {
			if (!email_touched) {
				const s = slug($name.val());
				$email.val(s ? `${s}@example.com` : "");
			}
		});
		// Clearing the email hands control back to auto-fill
		$email.on("input", () => (email_touched = $email.val() !== ""));
		$role_search.on("input", paint_roles);
		// Enter in the role filter should not submit the form
		$role_search.on("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				$role_list.find(".us-role input").first().trigger("click");
			}
		});

		function load_roles() {
			if (state.roles) return paint_roles();
			frappe.call({ method: `${API}.get_assignable_roles`, type: "GET" }).then((r) => {
				state.roles = r.message || [];
				paint_roles();
			});
		}

		function paint_roles() {
			if (!state.roles) return;
			const q = $role_search.val().trim().toLowerCase();
			const rows = state.roles.filter((r) => !q || r.name.toLowerCase().includes(q));
			const row_html = (r) => `<label class="us-role">
				<input type="checkbox" value="${esc(r.name)}" ${state.picked.has(r.name) ? "checked" : ""}>
				<span>${esc(r.name)}</span>
				${r.desk_access ? "" : `<span class="us-chip us-chip--web">${t("Portal")}</span>`}
			</label>`;
			// Editing: roles the user already has go first (by the saved set, so rows don't jump while ticking)
			const current = state.editing ? rows.filter((r) => state.original.has(r.name)) : [];
			const others = state.editing ? rows.filter((r) => !state.original.has(r.name)) : rows;
			const group = (title, list) => (list.length && current.length ? `<div class="us-group">${title}</div>` : "") + list.map(row_html).join("");
			$role_list.html(
				rows.length
					? (current.length ? `<div class="us-group">${t("Current roles ({0})", [current.length])}</div>` + current.map(row_html).join("") : "") +
							group(t("Other roles"), others)
					: `<div class="us-empty">${t("No roles match")}</div>`
			);
			$role_list.find("input").on("change", function () {
				this.checked ? state.picked.add(this.value) : state.picked.delete(this.value);
				paint_picked();
			});
			paint_picked();
		}

		function paint_picked() {
			const picked = [...state.picked];
			// Frappe derives the user type from the roles: any desk-access role makes a System User
			const desk = picked.some((r) => state.roles?.find((x) => x.name === r)?.desk_access);
			$create
				.find(".us-type-hint")
				.text(picked.length ? (desk ? t("→ System User") : t("→ Website User")) : t("none → Website User"));

			if (state.editing) {
				$create.find(".us-picked-count").text(t("· {0} selected", [picked.length]));
				const changed = picked.length !== state.original.size || picked.some((r) => !state.original.has(r));
				$create.find(".us-roles-save").prop("disabled", !changed);
			}
		}

		$create.on("submit", (e) => {
			e.preventDefault();
			if (!state.editing) create_user(true);
		});
		$create.find(".us-create-only").on("click", () => create_user(false));

		function create_user(and_switch) {
			const full_name = $name.val().trim();
			const email = $email.val().trim();
			if (!full_name) return $name.trigger("focus");
			if (!email) return $email.trigger("focus");

			const $buttons = $create.find(".us-btn").prop("disabled", true);
			if (and_switch) frappe.dom?.freeze?.(t("Creating {0}...", [esc(full_name)]));
			frappe
				.call({
					method: `${API}.create_test_user`,
					args: { full_name, email, roles: [...state.picked], switch: and_switch ? 1 : 0 },
					type: "POST",
				})
				.then((r) => {
					const u = { ...r.message, name: r.message.name };
					store.remember(u);
					if (and_switch) {
						window.location.pathname.startsWith("/app")
							? (window.location.href = "/app")
							: window.location.reload();
						return;
					}
					$buttons.prop("disabled", false);
					frappe.show_alert?.({ message: t("Created {0}", [esc(full_name)]), indicator: "green" });
					show_create(false);
					fetch_users();
				})
				.catch(() => {
					$buttons.prop("disabled", false);
					frappe.dom?.unfreeze?.();
				});
		}

		return { open };
	}

	// ---------- Ctrl+Shift+A: back to the real account ----------

	// Registered at module level (not inside the widget) so it works on every page, with the
	// widget closed, hidden, or not rendered yet. The server still decides if it's allowed.
	document.addEventListener(
		"keydown",
		(e) => {
			if (!is_back_shortcut(e) || current_user() === "Guest") return;
			e.preventDefault();
			e.stopPropagation();
			// Desk knows from boot; website pages may not have loaded that yet, so ask the server
			if (!who.is_switched && frappe.boot?.user) {
				frappe.show_alert?.({
					message: t("Already signed in as {0}", [esc(display_name(boot_user_info(current_user())))]),
					indicator: "blue",
				});
				return;
			}
			switch_back();
		},
		true
	);

	// ---------- boot ----------

	window.frappe.user_switcher = { switch_to, switch_back };

	on_ready(() => {
		if (current_user() === "Guest") return;
		// Desk knows from boot whether we're switched; show the banner before anything loads
		if (who.is_switched && frappe.boot?.user) {
			render_banner(boot_user_info(current_user()), boot_user_info(who.real));
		}
		check_allowed().then((allowed) => {
			if (!allowed) return;
			const widget = render_widget();
			frappe.user_switcher.open = widget.open;
		});
	});
})();
