const back = document.querySelector("#zp-back");
const home = document.querySelector("#zp-home");
const retry = document.querySelector("#zp-retry");

if (!(back instanceof HTMLButtonElement)
  || !(home instanceof HTMLButtonElement)
  || !(retry instanceof HTMLButtonElement)) {
  throw new DOMException("Invalid navigation failure document", "InvalidStateError");
}

back.addEventListener("click", () => history.back(), { once: true });
home.addEventListener("click", () => location.assign("/"), { once: true });
let retryStarted = false;
retry.addEventListener("click", () => {
  if (retryStarted) return;
  retryStarted = true;
  retry.disabled = true;
  const target = new URL(retry.dataset.path, location.origin);
  if (target.origin !== location.origin) throw new DOMException("Invalid retry route", "SecurityError");
  target.searchParams.set("_zp_retry", crypto.randomUUID());
  location.replace(target);
});
