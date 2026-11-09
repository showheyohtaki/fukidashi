// Runs unchanged against a browser Document or LinkeDOM. No API/audio needed.
export function speakerDomChecks(doc, scanner) {
  let cases = 0;
  const equal = (value, expected) => {
    if (JSON.stringify(value) !== JSON.stringify(expected))
      throw new Error(JSON.stringify({ value, expected }));
    cases++;
  };
  const a = doc.querySelector('[data-participant-id="customer-a"]');
  const b = doc.querySelector('[data-participant-id="customer-b"]');
  equal(scanner.scan(doc), ["佐藤"]);
  b.setAttribute("data-speaking", "true");
  equal(scanner.scan(doc), ["佐藤", "田中"]);
  a.querySelector("[aria-label]").setAttribute(
    "aria-label",
    "発話していません",
  );
  equal(scanner.scan(doc), ["田中"]);
  b.setAttribute("hidden", "");
  equal(scanner.scan(doc), []);
  b.removeAttribute("hidden");
  b.querySelector("span").textContent = "田中 営業";
  equal(scanner.scan(doc), ["田中 営業"]);
  b.remove();
  equal(scanner.scan(doc), []);
  a.classList.add("Oaajhc");
  equal(scanner.scan(doc), []);
  a.querySelector("[aria-label]").removeAttribute("aria-label");
  equal(scanner.scan(doc), ["佐藤"]);
  a.setAttribute("data-speaking", "false");
  equal(scanner.scan(doc), []);
  a.removeAttribute("data-speaking");
  a.querySelector("[data-self-name]").textContent = "You";
  equal(scanner.scan(doc), []);
  a.querySelector("[data-self-name]").textContent = "佐藤";
  a.setAttribute("data-is-local", "true");
  equal(scanner.scan(doc), []);
  a.removeAttribute("data-is-local");
  a.removeAttribute("data-participant-id");
  equal(scanner.scan(doc), []);
  return { status: "pass", cases, api: false };
}
