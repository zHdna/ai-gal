/**
 * User Profile Routes (multi-user + avatar upload)
 */
const { Router } = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure avatars directory exists
const avatarDir = path.join(__dirname, '..', '..', 'public', 'uploads', 'avatars');
fs.mkdirSync(avatarDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: avatarDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.png';
      cb(null, `user_${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('仅支持 PNG/JPG/GIF/WEBP 格式'));
    }
  }
});

module.exports = (db) => {
  const router = Router();

  // List all users
  router.get('/', (req, res) => {
    const rows = db.prepare('SELECT * FROM user_profile ORDER BY is_active DESC, id ASC').all();
    res.json(rows);
  });

  // Get active user
  router.get('/active', (req, res) => {
    const row = db.prepare('SELECT * FROM user_profile WHERE is_active = 1 LIMIT 1').get();
    res.json(row || { id: 0, name: '我', avatar: '', intro: '' });
  });

  // Create new user profile
  router.post('/', (req, res) => {
    const { name, avatar, intro, persona_name, persona_avatar } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: '姓名不能为空' });
    if (String(name).length > 50) return res.status(400).json({ error: '姓名过长（最大50字符）' });
    if (intro && String(intro).length > 2000) return res.status(400).json({ error: '简介过长（最大2000字符）' });

    const result = db.prepare('INSERT INTO user_profile (name, avatar, intro, persona_name, persona_avatar) VALUES (?, ?, ?, ?, ?)')
      .run(name.trim(), avatar || '', intro || '', persona_name || '', persona_avatar || '');
    const row = db.prepare('SELECT * FROM user_profile WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(row);
  });

  // Update user profile
  router.put('/:id', (req, res) => {
    const { name, avatar, intro, persona_name, persona_avatar } = req.body;
    const existing = db.prepare('SELECT * FROM user_profile WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: '用户不存在' });

    // Validate
    if (name !== undefined && name !== null) {
      if (!String(name).trim()) return res.status(400).json({ error: '姓名不能为空字符串' });
      if (String(name).length > 50) return res.status(400).json({ error: '姓名过长（最大50字符）' });
    }
    if (intro !== undefined && intro !== null && String(intro).length > 2000) {
      return res.status(400).json({ error: '简介过长（最大2000字符）' });
    }
    if (persona_name !== undefined && persona_name !== null && String(persona_name).length > 50) {
      return res.status(400).json({ error: '扮演角色名过长（最大50字符）' });
    }

    db.prepare(`UPDATE user_profile SET name = COALESCE(?, name), avatar = COALESCE(?, avatar), intro = COALESCE(?, intro), persona_name = COALESCE(?, persona_name), persona_avatar = COALESCE(?, persona_avatar), updated_at = datetime('now') WHERE id = ?`)
      .run(name, avatar, intro, persona_name, persona_avatar, req.params.id);
    const row = db.prepare('SELECT * FROM user_profile WHERE id = ?').get(req.params.id);
    res.json(row);
  });

  // Delete user
  router.delete('/:id', (req, res) => {
    const existing = db.prepare('SELECT * FROM user_profile WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: '用户不存在' });
    if (existing.is_active) return res.status(400).json({ error: '不能删除当前激活的用户，请先切换到其他用户' });
    db.prepare('DELETE FROM user_profile WHERE id = ?').run(req.params.id);
    res.json({ message: '已删除' });
  });

  // Activate a user
  router.post('/:id/activate', (req, res) => {
    const existing = db.prepare('SELECT * FROM user_profile WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: '用户不存在' });
    db.prepare('UPDATE user_profile SET is_active = 0').run();
    db.prepare('UPDATE user_profile SET is_active = 1 WHERE id = ?').run(req.params.id);
    const row = db.prepare('SELECT * FROM user_profile WHERE id = ?').get(req.params.id);
    res.json(row);
  });

  // Upload avatar
  router.post('/:id/avatar', upload.single('avatar'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: '请选择图片文件' });
    const avatarPath = `/uploads/avatars/${req.file.filename}`;
    db.prepare('UPDATE user_profile SET avatar = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(avatarPath, req.params.id);
    const row = db.prepare('SELECT * FROM user_profile WHERE id = ?').get(req.params.id);
    res.json(row);
  });

  // Upload persona (in-game role-play) avatar
  router.post('/:id/persona-avatar', upload.single('avatar'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: '请选择图片文件' });
    const avatarPath = `/uploads/avatars/${req.file.filename}`;
    db.prepare('UPDATE user_profile SET persona_avatar = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(avatarPath, req.params.id);
    const row = db.prepare('SELECT * FROM user_profile WHERE id = ?').get(req.params.id);
    res.json(row);
  });

  return router;
};
