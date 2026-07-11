const db = require('./db');

// Three memory layers:
//  - short-term: the recent message window sent with every chat (see ai.js)
//  - long_term:  lasting facts the AI saves explicitly (allergies, doctors, preferences)
//  - episodic:   AI-written summaries of older conversation stretches, created
//                automatically once enough messages age out of the short-term window

const EPISODE_TRIGGER = 40; // summarize once this many messages are unsummarized...
const EPISODE_KEEP_RECENT = 20; // ...but always leave this many for the short-term window
const MAX_LONG_TERM = 200;

function saveMemory(userId, content) {
  content = String(content || '').trim().slice(0, 1000);
  if (!content) throw new Error('Memory content is required.');
  const count = db.prepare("SELECT COUNT(*) c FROM memories WHERE user_id = ? AND kind = 'long_term'").get(userId).c;
  if (count >= MAX_LONG_TERM) throw new Error('Long-term memory is full — forget something first.');
  const info = db.prepare("INSERT INTO memories (user_id, kind, content) VALUES (?, 'long_term', ?)").run(userId, content);
  return { saved: { id: info.lastInsertRowid, content } };
}

function forgetMemory(userId, id) {
  const row = db.prepare("SELECT id, content FROM memories WHERE user_id = ? AND id = ? AND kind = 'long_term'").get(userId, id);
  if (!row) throw new Error(`No long-term memory with id ${id}.`);
  db.prepare('DELETE FROM memories WHERE id = ?').run(row.id);
  return { forgot: row.content };
}

function listMemories(userId, kind, limit = 50) {
  return db.prepare(
    'SELECT id, content, created_at FROM memories WHERE user_id = ? AND kind = ? ORDER BY id DESC LIMIT ?'
  ).all(userId, kind, limit);
}

function searchMemories(userId, query, limit = 10) {
  const q = `%${String(query || '').trim().replace(/[%_]/g, ' ')}%`;
  return db.prepare(
    'SELECT id, kind, content, created_at FROM memories WHERE user_id = ? AND content LIKE ? ORDER BY id DESC LIMIT ?'
  ).all(userId, q, limit);
}

// Builds the memory block injected into the system prompt each turn.
function memoryContext(userId) {
  const longTerm = listMemories(userId, 'long_term', 40).reverse();
  const episodes = listMemories(userId, 'episodic', 3).reverse();
  let out = '';
  if (longTerm.length) {
    out += '\n\nLong-term memories about this user (id: content):\n'
      + longTerm.map((m) => `- [${m.id}] ${m.content}`).join('\n');
  }
  if (episodes.length) {
    out += '\n\nSummaries of earlier conversations (episodic memory, oldest first):\n'
      + episodes.map((m) => `- (${m.created_at.slice(0, 10)}) ${m.content}`).join('\n');
  }
  return out;
}

// Summarize messages that have aged out of the short-term window into an
// episodic memory. Runs after a chat turn; needs the LLM, so the caller passes
// a `complete(messages) -> text` function.
async function summarizeEpisodeIfNeeded(userId, complete) {
  const watermark = db.prepare(
    "SELECT COALESCE(MAX(last_message_id), 0) w FROM memories WHERE user_id = ? AND kind = 'episodic'"
  ).get(userId).w;
  const unsummarized = db.prepare(
    'SELECT id, role, content FROM messages WHERE user_id = ? AND id > ? ORDER BY id'
  ).all(userId, watermark);
  if (unsummarized.length < EPISODE_TRIGGER) return null;

  const chunk = unsummarized.slice(0, unsummarized.length - EPISODE_KEEP_RECENT);
  const transcript = chunk.map((m) => `${m.role}: ${m.content}`).join('\n').slice(0, 24000);
  const summary = (await complete([
    {
      role: 'system',
      content: 'You summarize conversation excerpts into compact episode memories for a health-tracking assistant. Write 3-6 sentences in third person capturing: health values logged (glucose, insulin, meds, meals), appointments, how the user was feeling, decisions made, and anything worth recalling weeks later. Include concrete numbers and dates when present. Output only the summary.',
    },
    { role: 'user', content: transcript },
  ])).trim().slice(0, 2000);
  if (!summary) return null;

  db.prepare(
    "INSERT INTO memories (user_id, kind, content, last_message_id) VALUES (?, 'episodic', ?, ?)"
  ).run(userId, summary, chunk[chunk.length - 1].id);
  return summary;
}

module.exports = { saveMemory, forgetMemory, listMemories, searchMemories, memoryContext, summarizeEpisodeIfNeeded };
