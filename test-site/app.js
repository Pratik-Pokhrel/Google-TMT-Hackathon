const storyBlocks = document.getElementById('storyBlocks');
const wordCount = document.getElementById('wordCount');
const paraCount = document.getElementById('paraCount');
const stamp = document.getElementById('stamp');
const regenBtn = document.getElementById('regenBtn');

const topics = [
  'browser extensions',
  'translation pipelines',
  'real-time rendering',
  'progressive content loading',
  'cache-aware APIs',
  'viewport visibility',
  'page restoration',
  'user-triggered actions',
];

const phrases = [
  'Share',
  'Read more',
  'Subscribe',
  'Continue',
  'Open in new tab',
  'Save for later',
  'Translate this page',
  'Loading section',
];

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function makeSentence(seed, idx) {
  const topic = randomItem(topics);
  const phrase = randomItem(phrases);
  const extra = idx % 2 === 0
    ? 'This sentence is intentionally a bit longer so that batching logic has something meaningful to group.'
    : 'Short text nodes like this help test how quickly the extension updates visible content.';
  return `${seed} ${idx + 1}: ${topic} is where ${phrase.toLowerCase()} meets ${extra}`;
}

function renderPage() {
  const blocks = [];
  let totalWords = 0;

  for (let i = 0; i < 18; i++) {
    const title = `Section ${String(i + 1).padStart(2, '0')} — ${randomItem(topics)}`;
    const paragraph = makeSentence('Random paragraph', i);
    const secondary = makeSentence('Follow-up note', i + 3);
    const words = `${title} ${paragraph} ${secondary}`.trim().split(/\s+/).length;
    totalWords += words;

    blocks.push(`
      <section class="story-card">
        <h3>${title}</h3>
        <p>${paragraph}</p>
        <p>${secondary}</p>
        <div class="meta">
          <span class="badge">Cache-friendly</span>
          <span class="badge">Batch test</span>
          <span class="badge">Visible-first</span>
          <span class="badge">${randomItem(phrases)}</span>
        </div>
      </section>
    `);
  }

  storyBlocks.innerHTML = blocks.join('');
  wordCount.textContent = totalWords.toLocaleString();
  paraCount.textContent = document.querySelectorAll('.story-card p').length.toLocaleString();
  stamp.textContent = new Date().toLocaleTimeString();
}

regenBtn.addEventListener('click', renderPage);
window.addEventListener('load', renderPage);
