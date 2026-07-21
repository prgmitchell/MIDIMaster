export function captureElementScroll(element) {
  return {
    top: Number(element?.scrollTop || 0),
    left: Number(element?.scrollLeft || 0),
  };
}

export function restoreElementScroll(element, position = {}) {
  if (!element) return;
  const top = Number(position.top);
  const left = Number(position.left);
  element.scrollTop = Number.isFinite(top) ? top : 0;
  element.scrollLeft = Number.isFinite(left) ? left : 0;
}
