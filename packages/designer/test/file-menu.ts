import { fireEvent, screen } from "@testing-library/react";

/** Opens the top bar's File menu, unless it is open already. */
function openFileMenu(): void {
  const button = screen.getByRole("button", { name: /^File/ });
  if (button.getAttribute("aria-expanded") !== "true") fireEvent.click(button);
}

/** The File menu's item `name`, opening the menu first. */
export function fileMenuItem(name: string): HTMLElement {
  openFileMenu();
  return screen.getByRole("menuitem", { name });
}

/** The File menu's item `name` once the File button renders, opening the menu first. */
export async function findFileMenuItem(name: string): Promise<HTMLElement> {
  await screen.findByRole("button", { name: /^File/ });
  return fileMenuItem(name);
}
