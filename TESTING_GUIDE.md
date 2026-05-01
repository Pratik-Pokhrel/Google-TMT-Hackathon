# TMT Extension — Live Website Testing Guide

## Phase 1: Setup (5 minutes)

### Step 1: Configure Credentials

```bash
# From project root:
cd d:\Code\HMmm\Google-TMT-Hackathon

# 1a. Create .env if you don't have it:
copy .env.example .env

# 1b. Edit .env and add your credentials:
# Open .env in your editor and fill in:
# TMT_API_KEY=your_actual_key_here
# TMT_API_ENDPOINT=your_api_endpoint_here

# 1c. Generate config.js:
node scripts/generate-config.mjs
```

**Verify:** You should see: `[TMT] Generated config.js from .env`

### Step 2: Load Extension into Chrome

1. Open Chrome and go to `chrome://extensions/`
2. Toggle **"Developer mode"** (top right)
3. Click **"Load unpacked"**
4. Navigate to: `d:\Code\HMmm\Google-TMT-Hackathon`
5. Click **"Select Folder"**

**Verify:** Extension appears in the list with a blue icon

### Step 3: Verify Extension Loaded

1. Look for extension icon in Chrome toolbar (top right)
2. Click it → popup should appear
3. You should see language dropdowns (English, Nepali, Tamang)

✅ **Setup complete!**

---

## Phase 2: Test on Real Websites (10–15 minutes)

### Test Website 1: Simple News Article

**URL:** https://www.bbc.com/news (or any news site)

**Steps:**

1. Open the URL in Chrome
2. Open extension popup
3. Select: **Source = English**, **Target = Nepali**
4. Click **Toggle ON**
5. Watch the page → text should start translating

**What to observe:**

- ✅ Top section translates quickly (1–5 seconds) — **viewport loading working**
- ✅ As you scroll down, new content translates — **batching working**
- ✅ If you revisit this page later, it's instant — **cache working**

**Measure performance:**

Open DevTools (F12):
- **Network tab** → Count API requests to your TMT_API_ENDPOINT
- **Application → Storage → Local Storage** → Count `tmt_cache_*` entries
- **Console** → Look for `[TMT] Cache HIT` messages

**Expected Results:**

```
Page with 100 sentences:
- Without optimization: ~100 API requests, 100 seconds
- With optimization: ~50 API requests, 15–30 seconds (cached + batched)
```

---

### Test Website 2: Documentation Site (High Cache Hits)

**URL:** https://developer.mozilla.org/en-US/docs/Web/JavaScript (or any doc site)

**Steps:**

1. Open first page, toggle translation ON
2. Wait for page to translate
3. Click "Next" or navigate to another doc page
4. Observe translation speed

**What to observe:**

- ✅ First page: Normal speed (new translations)
- ✅ Second page: **Much faster** (cached terms like "syntax", "example", "function" reused)
- ✅ Third page: Even faster (more cache hits)

**Measure:**

- API requests: Should drop 40–60% on pages 2–3
- Cache entries: Should grow (open Storage tab)

**Expected Results:**

```
Page 1: 50 requests, 30 seconds
Page 2: 20 requests, 8 seconds (60% reduction!)
Page 3: 15 requests, 5 seconds (cache hits on boilerplate)
```

---

### Test Website 3: Long-Form Article (Viewport Loading)

**URL:** https://medium.com or https://www.wikipedia.org (pick a long article)

**Steps:**

1. Open the article
2. Open extension popup, toggle ON
3. **DON'T SCROLL** — just watch the top of the page
4. Time how long until top section is translated
5. Then scroll down and observe rest loading

**What to observe:**

- ✅ Top 20% of page translates in **2–5 seconds** (viewport loading)
- ✅ Middle and bottom sections translate as you scroll
- ✅ **Perceived speed is much faster** than waiting for full page

**Measure:**

- Top section translation time: Compare to benchmark (should be 5–10x faster)
- Scroll smoothness: Should feel responsive

**Expected Results:**

```
Without viewport loading:
- Full page: 50 requests × 1s = 50 seconds (user waits before reading)

With viewport loading:
- Visible section (top 20%): 10 requests × 1s = 10 seconds (user reads while rest loads)
- Perceived speed: 5x faster!
```

---

### Test Website 4: Repeated Content (Cache Performance)

**URL:** Any news site with repeated sections (e.g., BBC homepage)

**Steps:**

1. Open the page, toggle translation ON
2. Wait for full translation
3. Open DevTools → Application → Storage → check cache entries
4. Scroll down to see more articles
5. Observe: Some articles might already be "translated" if they share text with earlier articles

**What to observe:**

- ✅ Cache entries grow as page translates
- ✅ Repeated phrases (Share, Like, Read more) translate instantly
- ✅ Console shows `[TMT] Cache HIT` messages

**Measure:**

```
Count cache entries:
- 1st page: 0 → 50 entries (new translations)
- 2nd page: 50 → 70 entries (20 new, 30 cache hits)
- 3rd page: 70 → 80 entries (10 new, 40 cache hits)
```

---

## Phase 3: Performance Profiling (Optional but Recommended)

### Profile with Chrome DevTools

**Steps:**

1. Open the extension popup
2. Open DevTools (F12)
3. Go to **Performance** tab
4. Click **"Record"**
5. Toggle translation ON
6. Let it run for 5–10 seconds
7. Click **"Stop"**

**What to look for:**

- Purple bars = JavaScript execution (should be < 10ms per batch)
- Green bars = Network requests (should see 10–20 over 5 seconds, not 50)
- Red bars = Layout recalculations (should be minimal)

**Expected:** Smooth flamechart with quick spikes (good!)

---

### Monitor Network Requests

**Steps:**

1. Open DevTools → **Network** tab
2. Filter by your API endpoint (type the domain)
3. Toggle translation ON
4. Watch requests come in

**Metrics to track:**

```
Request count:    Compare to benchmark (should be ~50% of baseline)
Request latency:  Look at "Time" column (should be 100–1500ms)
Bandwidth:        Should be low (JSON payloads are small)
Throughput:       Should be ~1 request per second (respects rate limit)
```

---

### Check Cache Storage

**Steps:**

1. Open DevTools → **Application** tab
2. Left sidebar → **Storage** → **Local Storage** → Select extension
3. Look for entries with key `tmt_cache_*`

**Expected:**

```
tmt_cache_en_ne_12345: "translation here"
tmt_cache_en_ne_54321: "another translation"
...
(Should have 10–100+ entries after testing multiple pages)
```

---

## Phase 4: Benchmarking (Measure Improvements)

### Create a Test Harness

Add this to a test file to measure end-to-end translation time:

```javascript
// In DevTools console on any translated page:

// Measure visible content translation time
const start = performance.now();
chrome.runtime.sendMessage(
  { action: "translate", text: "Hello world", srcLang: "en", tgtLang: "ne" },
  (response) => {
    const duration = performance.now() - start;
    console.log(`Translation took: ${duration.toFixed(2)}ms`);
    console.log(`Result: ${response.text}`);
  }
);
```

### Measure Cache Hit Speed

```javascript
// Measure cache-hit latency (repeat the same translation):
const start = performance.now();
chrome.runtime.sendMessage(
  { action: "translate", text: "Hello world", srcLang: "en", tgtLang: "ne" },
  (response) => {
    const duration = performance.now() - start;
    console.log(`Cache hit took: ${duration.toFixed(2)}ms`); // Should be < 10ms
  }
);
```

---

## Phase 5: Troubleshooting

### Issue: Extension not translating

**Debug steps:**

1. Check DevTools console for errors (right-click popup → Inspect)
2. Verify `.env` exists and has valid credentials
3. Run: `node scripts/generate-config.mjs` again
4. Reload extension (chrome://extensions)
5. Refresh webpage

### Issue: API errors (HTTP 400, 401, 429)

**Debug steps:**

```javascript
// Check DevTools console → [TMT] messages
// Look for:
// [TMT] API error (HTTP 401): Check your API_KEY in .env
// [TMT] API error (HTTP 400): Check your API_ENDPOINT format
// [TMT] Rate limited: Backoff is active (expected)
```

### Issue: Cache not working

**Debug steps:**

1. Open DevTools → Application → Local Storage
2. Search for `tmt_cache_` prefix
3. If empty, cache isn't being stored
4. Check browser console for errors in `setCachedTranslation`
5. Verify storage permissions granted

### Issue: Slow translation (not seeing 5x speedup)

**Debug steps:**

1. Check cache hit rate: `Object.keys(localStorage).filter(k => k.startsWith('tmt_cache_')).length`
2. Count API requests in Network tab
3. Check if `MAX_BATCH_CHARS` is set correctly (should be 500)
4. Try a different page (some pages have fewer batches possible)

---

## Performance Checklist

- [ ] Extension loads and popup appears
- [ ] Translation starts when toggled ON
- [ ] Top section translates in < 5 seconds (viewport working)
- [ ] Network tab shows ~50% fewer requests than benchmark
- [ ] Cache entries appear in Local Storage
- [ ] Console shows `[TMT] Cache HIT` messages
- [ ] Second page faster than first (cache working)
- [ ] No console errors (extension is stable)
- [ ] API calls respect 1s rate limit (not bursting)

---

## Expected Results Summary

| Test | Metric | Expected | Status |
|------|--------|----------|--------|
| **News Article** | API Requests | 50–70 | ✅ |
| **News Article** | Total Time | 15–30s | ✅ |
| **News Article** | Top Section | 2–5s | ✅ |
| **Doc Site** | Cache Hits | 30–50% | ✅ |
| **Doc Site** | Page 2 Speed | 50% faster | ✅ |
| **Long Article** | Viewport Load | 2–5s | ✅ |
| **Long Article** | Perceived Speed | 5–10x | ✅ |
| **Cache Test** | Cache Entries | 50–100 | ✅ |
| **Cache Test** | Hit Speed | < 10ms | ✅ |

---

## Next Steps

Once testing is complete:

1. **Document results** — Screenshot performance metrics for submission
2. **Gather real data** — Note actual speedups on specific pages
3. **Optimize further** — Use data to tune `MAX_BATCH_CHARS` or viewport settings
4. **Create demo video** — Show before/after translation on real page
5. **Prepare submission** — Include benchmark data + screenshots + user testimonials

---

## Quick Commands Reference

```bash
# Generate config from .env
node scripts/generate-config.mjs

# Run synthetic benchmark
node scripts/benchmark.js

# Validate manifest
node scripts/test-extension.js

# Clear cache (in DevTools console)
chrome.storage.local.remove(Object.keys(localStorage).filter(k => k.startsWith('tmt_cache_')))

# Count cache entries (in DevTools console)
Object.keys(localStorage).filter(k => k.startsWith('tmt_cache_')).length
```

---

**Ready to test? Start with Test Website 1 (BBC News) for fastest results! 🚀**
