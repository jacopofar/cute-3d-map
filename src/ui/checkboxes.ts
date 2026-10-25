// The layer checkboxes remember their state across reloads in one cookie. The
// map is the only thing that needs this, but it is plain DOM and cookie work
// with no map in it, so it lives on its own.

const CHECKBOX_COOKIE = "map-checkboxes";
const CHECKBOX_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

function readCheckboxCookie(): Record<string, boolean> {
  const prefix = `${CHECKBOX_COOKIE}=`;
  const entry = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  if (!entry) return {};
  try {
    const parsed: unknown = JSON.parse(
      decodeURIComponent(entry.slice(prefix.length)),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([key, value]) => key.length > 0 && typeof value === "boolean",
      ),
    );
  } catch {
    return {};
  }
}

// the state one switch was left in, or undefined when it was never saved
export function savedCheckbox(id: string): boolean | undefined {
  return readCheckboxCookie()[id];
}

// keyed by the label id (`#benches-toggle`) when there is one, so the state
// survives a change in the markup inside the label
export function checkboxStates(): Record<string, boolean> {
  const states: Record<string, boolean> = {};
  document
    .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    .forEach((input, index) => {
      const label = input.closest("label");
      states[label?.id || input.id || `checkbox-${index}`] = input.checked;
    });
  return states;
}

export function restoreCheckboxStates() {
  for (const [id, checked] of Object.entries(readCheckboxCookie())) {
    const label = document.getElementById(id);
    const input = label?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    if (input) input.checked = checked;
  }
}

export function saveCheckboxStates() {
  const value = encodeURIComponent(JSON.stringify(checkboxStates()));
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${CHECKBOX_COOKIE}=${value}; Max-Age=${CHECKBOX_COOKIE_MAX_AGE}; Path=/; SameSite=Lax${secure}`;
}
