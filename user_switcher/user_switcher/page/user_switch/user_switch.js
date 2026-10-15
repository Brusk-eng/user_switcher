// /app/user-switch/<user> — target of the Ctrl+K "switch <name>" results.
// It is deliberately open to every desk role (switching into a non-admin must not lock
// you out of it); the API decides who may actually switch.
frappe.pages["user-switch"].on_page_load = function (wrapper) {
	frappe.ui.make_app_page({ parent: wrapper, title: __("Switch User"), single_column: true });
};

frappe.pages["user-switch"].on_page_show = function (wrapper) {
	const target = frappe.get_route().slice(1).join("/");
	// Frappe's router copies every URL query parameter into frappe.route_options, so a pasted link
	// can set any flag. Nothing here may trust it: this page always asks before switching. (Picking
	// a Ctrl+K result switches straight away through the awesomplete-select handler in the bundle.)
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
