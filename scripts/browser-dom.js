// Playwright serializes this factory into the current document. Its closures stay in Chromium.
export function createDomHelpers() {
  const getParentOrHost = (el) => el.assignedSlot || el.parentElement || el.getRootNode().host;

  function queryDeep(root, selector, results = []) {
    if (root.shadowRoot) queryDeep(root.shadowRoot, selector, results);
    for (const el of root.querySelectorAll('*')) {
      if (el.matches(selector)) results.push(el);
      if (el.shadowRoot) queryDeep(el.shadowRoot, selector, results);
    }
    return results;
  }

  function isVisible(el) {
    const style = getComputedStyle(el);
    const native = typeof el.checkVisibility === 'function';
    let boxedAncestor;
    for (let cur = el; cur; cur = getParentOrHost(cur)) {
      if (cur.hasAttribute('hidden') || cur.hasAttribute('inert') ||
          cur.getAttribute('aria-hidden')?.toLowerCase() === 'true') return false;
      if (native && style.display === 'contents' && !boxedAncestor && getComputedStyle(cur).display !== 'contents') {
        boxedAncestor = cur;
      }
      if (!native) {
        const ancestor = cur === el ? style : getComputedStyle(cur);
        if (ancestor.display === 'none' || ancestor.opacity === '0' ||
            (cur !== el && ancestor.contentVisibility === 'hidden')) return false;
      }
    }

    if (style.display === 'contents') {
      const children = el instanceof HTMLSlotElement
        ? el.assignedNodes({ flatten: true }) : (el.shadowRoot || el).childNodes;
      return Array.from(children).some(child => {
        if (child.nodeType === Node.ELEMENT_NODE) return isVisible(child);
        if (child.nodeType !== Node.TEXT_NODE || !child.textContent.trim() ||
            style.visibility !== 'visible') return false;
        if (boxedAncestor && (!boxedAncestor.checkVisibility({ checkOpacity: true, contentVisibilityAuto: true }) ||
            getComputedStyle(boxedAncestor).contentVisibility === 'hidden')) return false;
        const range = document.createRange();
        range.selectNodeContents(child);
        const rect = range.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    }
    if (native) {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) return false;
    } else if (style.visibility !== 'visible') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  return { getParentOrHost, queryDeep, isVisible };
}

export async function evaluateDom(page, callback, arg) {
  const helpers = await page.evaluateHandle(createDomHelpers);
  try {
    return await helpers.evaluate(callback, arg);
  } finally {
    await helpers.dispose();
  }
}
