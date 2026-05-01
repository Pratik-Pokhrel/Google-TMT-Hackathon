// PRE-BUFFERING MODULE
// When translation is active on the current tab, monitor user scroll/navigation patterns.
// Pre-translate frequently visited pages or pages the user is about to visit.
// This reduces perceived latency during page transitions.

export const preBufferModule = {
  // Track page visit patterns to predict next page
  visitHistory: [],
  maxHistory: 10,
  
  recordPageVisit(url, translationCount) {
    this.visitHistory.push({ url, time: Date.now(), count: translationCount });
    if (this.visitHistory.length > this.maxHistory) {
      this.visitHistory.shift();
    }
  },

  // Suggest likely next pages for pre-buffering
  getProbableNextPages() {
    if (this.visitHistory.length < 2) return [];
    
    // Simple heuristic: look for navigation patterns
    // On news sites: "next article" links
    // On docs: "next chapter" links
    const probable = [];
    
    // Find links that look like "next" or numbered pagination
    const linkSelector = 'a[rel*="next"], a:contains("Next"), a:contains("next"), .pagination a[data-page]';
    
    return probable;
  },

  // Background service worker can call this to pre-fetch translations
  // for common navigation destinations
  preTranslateLinks(tabId, srcLang, tgtLang) {
    const links = document.querySelectorAll('a[href^="http"], a[href^="/"]');
    const candidates = [];
    
    // Collect up to 5 likely next links
    for (const link of links) {
      if (candidates.length >= 5) break;
      const text = link.textContent?.trim();
      if (text && text.length > 3 && text.length < 200) {
        candidates.push({ text, href: link.href });
      }
    }
    
    return candidates;
  }
};
