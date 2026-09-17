/**
 * BGM Routes - serve MP3 files from BGM folder
 */
const path = require('path');
const fs = require('fs');

const BGM_DIR = path.join(__dirname, '..', '..', 'BGM');

// Mood → folder mapping
const MOOD_MAP = {
  battle: 'battle', blue: 'blue', ceremony: 'ceremony',
  relaxed: 'relaxed', nomal: 'nomal', suspense: 'suspense'
};

module.exports = () => {
  const router = require('express').Router();

  // List available moods + files (MUST be before /:file)
  router.get('/', (req, res) => {
    const result = {};
    for (const [mood, folder] of Object.entries(MOOD_MAP)) {
      const moodPath = path.join(BGM_DIR, folder);
      if (fs.existsSync(moodPath)) {
        const files = fs.readdirSync(moodPath).filter(f => f.endsWith('.mp3'));
        result[mood] = files;
      }
    }
    res.json(result);
  });

  // Serve MP3 files (with optional subfolder)
  router.get('/:folder/:file', (req, res) => {
    const folder = req.params.folder.replace(/[^a-zA-Z0-9_\-]/g, '');
    const file = req.params.file.replace(/[^a-zA-Z0-9_\-\.]/g, '').replace(/^\.+/, '').replace(/\.{2,}/g, '.');
    const filePath = path.join(BGM_DIR, folder, file);
    serveFile(res, filePath);
  });

  // Serve MP3 files (root level — fallback)
  router.get('/:file', (req, res) => {
    const file = req.params.file.replace(/[^a-zA-Z0-9_\-\.]/g, '').replace(/^\.+/, '').replace(/\.{2,}/g, '.');
    // Search in all mood folders
    for (const folder of Object.values(MOOD_MAP)) {
      const filePath = path.join(BGM_DIR, folder, file);
      if (fs.existsSync(filePath)) {
        return serveFile(res, filePath);
      }
    }
    res.status(404).send('Not found');
  });

  function serveFile(res, filePath) {
    if (fs.existsSync(filePath)) {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Accept-Ranges', 'bytes');
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.status(404).send('Not found');
    }
  }

  return router;
};
