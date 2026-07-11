const fs = require('fs');
const path = require('path');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const filesRoot = path.join(dataDir, 'files');

const ALLOWED_EXT = new Set(['.txt', '.md', '.csv', '.html', '.json']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES_PER_USER = 200;

// Strict allowlist sanitization — the filename comes from the LLM.
function sanitizeName(name) {
  const base = path.basename(String(name || '').trim()).replace(/[^a-zA-Z0-9._ -]/g, '_');
  if (!base || base.startsWith('.')) throw new Error('Invalid filename.');
  const ext = path.extname(base).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(`File type "${ext || '(none)'}" not allowed. Use one of: ${[...ALLOWED_EXT].join(', ')}`);
  }
  return base.slice(0, 100);
}

function userDir(userId) {
  const dir = path.join(filesRoot, String(Number(userId)));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createUserFile(userId, filename, content) {
  const name = sanitizeName(filename);
  const text = String(content ?? '');
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) throw new Error('File too large (max 2 MB).');
  const dir = userDir(userId);
  if (fs.readdirSync(dir).length >= MAX_FILES_PER_USER) throw new Error('File limit reached — delete some files first.');

  // Avoid silently overwriting: append -1, -2, ... on collision.
  let finalName = name;
  const ext = path.extname(name);
  const stem = name.slice(0, -ext.length);
  for (let i = 1; fs.existsSync(path.join(dir, finalName)); i++) {
    finalName = `${stem}-${i}${ext}`;
  }
  fs.writeFileSync(path.join(dir, finalName), text, 'utf8');
  return {
    filename: finalName,
    bytes: Buffer.byteLength(text, 'utf8'),
    download_url: `/api/files/${encodeURIComponent(finalName)}`,
  };
}

function listUserFiles(userId) {
  const dir = userDir(userId);
  return fs.readdirSync(dir)
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { filename: f, bytes: st.size, modified_at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.modified_at.localeCompare(a.modified_at));
}

function userFilePath(userId, filename) {
  const name = sanitizeName(filename);
  const full = path.join(userDir(userId), name);
  if (!fs.existsSync(full)) throw new Error('File not found.');
  return full;
}

function deleteUserFile(userId, filename) {
  fs.unlinkSync(userFilePath(userId, filename));
  return { deleted: filename };
}

module.exports = { createUserFile, listUserFiles, userFilePath, deleteUserFile };
