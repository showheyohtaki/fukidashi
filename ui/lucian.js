// Lucian UX/UI Prompt #013 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#013
// Lucian UX/UI Prompt #017 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#017
// Lucian UX/UI Prompt #037 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#037
// Lucian UX/UI Prompt #072 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#072
// Lucian UX/UI Prompt #079 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#079
// Lucian UX/UI Prompt #092 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#092
// Lucian UX/UI Prompt #269 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#269
// Lucian UX/UI Prompt #305 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#305
// Behavior adaptations. Canvas dimensions, colors and typography are in sidepanel.css.
export const reduced = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches ||
  document.documentElement.dataset.motion === "reduce";
export function bindSwitch(button, onChange) {
  let drag = null,
    skip = false;
  const set = (value) => {
    button.setAttribute("aria-checked", String(value));
    button.classList.add("stretch");
    setTimeout(() => button.classList.remove("stretch"), reduced() ? 0 : 170);
    onChange(value);
  };
  button.addEventListener("pointerdown", (e) => {
    drag = {
      x: e.clientX,
      start: button.getAttribute("aria-checked") === "true",
      moved: false,
    };
    button.setPointerCapture(e.pointerId);
  });
  button.addEventListener("pointermove", (e) => {
    if (drag && Math.abs(e.clientX - drag.x) > 4) drag.moved = true;
  });
  button.addEventListener("pointerup", (e) => {
    if (drag?.moved) {
      set(e.clientX > drag.x);
      skip = true;
    }
    drag = null;
  });
  button.addEventListener("pointercancel", () => {
    drag = null;
    skip = false;
  });
  button.addEventListener("click", () => {
    if (skip) {
      skip = false;
      return;
    }
    set(button.getAttribute("aria-checked") !== "true");
  });
}
export function bindRange(input, output, onChange) {
  const update = () => {
    output.textContent = input.value;
    input.setAttribute(
      "aria-valuetext",
      input.value + (input.dataset.unit || ""),
    );
  };
  input.addEventListener("input", update);
  input.addEventListener("change", () => onChange(Number(input.value)));
  input.addEventListener("keydown", (e) => {
    if (!["PageUp", "PageDown", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const min = Number(input.min),
      max = Number(input.max),
      step = Number(input.step) || 1;
    input.value =
      e.key === "Home"
        ? min
        : e.key === "End"
          ? max
          : Math.max(
              min,
              Math.min(
                max,
                Number(input.value) + (e.key === "PageUp" ? 10 : -10) * step,
              ),
            );
    update();
    onChange(Number(input.value));
  });
  update();
}
export function menu(trigger, el) {
  const hide = () => {
    el.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };
  const close = () => {
    hide();
    trigger.focus();
  };
  trigger.addEventListener("click", () => {
    if (!el.hidden) return close();
    el.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    setTimeout(
      () => el.querySelector("[role=menuitem]")?.focus(),
      reduced() ? 0 : 60,
    );
  });
  el.addEventListener("keydown", (e) => {
    const items = [...el.querySelectorAll("[role=menuitem]")],
      i = items.indexOf(document.activeElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      items[
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? items.length - 1
            : (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) %
              items.length
      ]?.focus();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
    if (e.key === "Tab") hide();
  });
  const outside = (e) => {
    if (!el.hidden && !el.contains(e.target) && !trigger.contains(e.target))
      hide();
  };
  document.addEventListener("pointerdown", outside);
  return {
    close,
    hide,
    destroy: () => document.removeEventListener("pointerdown", outside),
  };
}
export function openDialog(dialog, trigger, locked = false) {
  dialog.dataset.locked = String(locked);
  dialog.showModal();
  dialog.querySelector("[autofocus],button")?.focus();
  const cancel = (e) => {
    if (locked) e.preventDefault();
  };
  dialog.addEventListener("cancel", cancel);
  dialog.addEventListener(
    "close",
    () => {
      dialog.removeEventListener("cancel", cancel);
      trigger?.focus();
    },
    { once: true },
  );
}
export function showSheet(sheet, trigger, lower) {
  sheet.hidden = false;
  trigger?.setAttribute("aria-expanded", "true");
  lower.inert = true;
  sheet.querySelector("[role=tab]")?.focus();
  return () => {
    sheet.hidden = true;
    lower.inert = false;
    trigger?.setAttribute("aria-expanded", "false");
    trigger?.focus({ preventScroll: true });
  };
}
export function replaceAlerts(node, markup, focusTarget) {
  const hadFocus = node.contains(document.activeElement);
  const action = hadFocus ? document.activeElement.dataset.action : null;
  node.innerHTML = markup;
  if (hadFocus) {
    const buttons = [...node.querySelectorAll("button")];
    (
      buttons.find((button) => button.dataset.action === action) ||
      buttons[0] ||
      focusTarget
    )?.focus({ preventScroll: true });
  }
}
export function emptyAction(button, action, focusTarget) {
  button.addEventListener("click", async () => {
    await action();
    if (!button.isConnected) focusTarget?.focus({ preventScroll: true });
  });
}
