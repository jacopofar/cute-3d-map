// The layer checkboxes, the menu they live in and the help popover. All DOM,
// no map: the map hands in one row per switch and gets the flag back, so the
// wiring for a layer is a row here rather than a callback buried in the
// constructor.

import { saveCheckboxStates } from "./checkboxes";

export interface ToggleControl {
  /** the checkbox label's id, e.g. `#windows-toggle` */
  id: string;
  /** store the new state; also called once at boot with the saved state */
  set(on: boolean): void;
  /** re-apply whatever the flag drives; not run at boot, since the layers
   * build from the flag anyway */
  apply?(): void;
}

// The cookie restores a checkbox before the map exists, so the DOM is the
// source of truth at boot: seed each flag from it, then follow changes.
export function wireControls(controls: readonly ToggleControl[]): void {
  for (const control of controls) {
    const input = document.querySelector<HTMLInputElement>(
      `${control.id} input`,
    );
    if (!input) continue;
    control.set(input.checked);
    input.addEventListener("change", () => {
      control.set(input.checked);
      control.apply?.();
    });
  }
}

// The gear opens the layer list; the chevron at the top of the list folds it.
// Returns the setter, because entering car mode gets the panel out of the way.
export function wireLayerMenu(): (open: boolean) => void {
  const button =
    document.querySelector<HTMLButtonElement>("#layer-menu-button");
  const panel = document.querySelector<HTMLElement>("#layer-menu-panel");
  const collapse = document.querySelector<HTMLButtonElement>(
    "#layer-menu-collapse",
  );
  const setOpen = (open: boolean) => {
    if (!button || !panel) return;
    panel.hidden = !open;
    button.hidden = open;
    button.setAttribute("aria-expanded", String(open));
  };
  button?.addEventListener("click", () => setOpen(true));
  collapse?.addEventListener("click", () => setOpen(false));
  return setOpen;
}

// The question mark next to "imputed colors" explains what it means.
export function wireImputedHelp(): void {
  const button = document.querySelector<HTMLButtonElement>("#imputed-help");
  const text = document.querySelector<HTMLElement>("#imputed-help-text");
  if (!button || !text) return;
  button.addEventListener("click", () => {
    const open = Boolean(text.hidden);
    text.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  });
}

// Every checkbox state is remembered in the cookie, and any change is worth a
// perf event; the map supplies what "worth reporting" means.
export function onCheckboxChange(changed: () => void): void {
  document.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") {
      return;
    }
    saveCheckboxStates();
    changed();
  });
}
