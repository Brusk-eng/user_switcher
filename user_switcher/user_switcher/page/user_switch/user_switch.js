// /app/user-switch/<user> — target of the Ctrl+K "switch <name>" results.
// It is deliberately open to every desk role (switching into a non-admin must not lock
// you out of it); the API decides who may actually switch.
frappe.pages["user-switch"].on_page_load = function (wrapper) {
	frappe.ui.make_app_page({ parent: wrapper, title: __("Switch User"), single_column: true });
};

frappe.pages["user-switch"].on_page_show = function (wrapper) {
	const target = frappe.get_route().slice(1).join("/");
	// route_options can only be set by in-app navigation (the awesome bar), never by a pasted
	// link, so a link someone sends you can't silently switch your session.
	const from_search = !!frappe.route_options?.from_awesomebar;
	frappe.route_options = null;

	const $body = $(wrapper).find(".layout-main-section").empty();
	if (!target) {
		$body.html(`<p class="text-muted">${__("Press {0} and type \"switch\" to pick a user.", ["Ctrl+K"])}</p>`);
		return;
	}
	if (!frappe.user_switcher) {
		$body.html(`<p class="text-muted">${__("User Switcher is not available on this site.")}</p>`);
		return;
	}

	if (from_search) {
		frappe.user_switcher.switch_to({ name: target });
		return;
	}

	$body.html(`
		<div class="us-confirm">
			<p>${__("Switch your session to {0}?", [`<b>${frappe.utils.escape_html(target)}</b>`])}</p>
			<button class="btn btn-primary btn-sm us-confirm-btn">${__("Switch")}</button>
			<button class="btn btn-default btn-sm us-cancel-btn">${__("Cancel")}</button>
		</div>
	`);
	$body.find(".us-confirm-btn").on("click", () => frappe.user_switcher.switch_to({ name: target })).trigger("focus");
	$body.find(".us-cancel-btn").on("click", () => window.history.back());
};
