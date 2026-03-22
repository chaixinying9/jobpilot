const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const PizZip = require('pizzip');
const mammoth = require('mammoth');
const { PDFParse } = require('pdf-parse');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'jobpilot-jwt-secret-change-in-prod';
const JWT_EXPIRES = '30d';

const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.json({ limit: '10mb' }));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const ts = Date.now();
        const rand = Math.random().toString(36).slice(2, 10);
        const ext = path.extname(file.originalname);
        cb(null, `${ts}-${rand}${ext}`);
    }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ============ Data Layer (JSON files) ============
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const RESUMES_FILE = path.join(DATA_DIR, 'resumes.json');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

function readJSON(file) {
    if (!fs.existsSync(file)) return [];
    try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return []; }
}
function writeJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

function loadUsers() { return readJSON(USERS_FILE); }
function saveUsers(u) { writeJSON(USERS_FILE, u); }
function loadResumes() { return readJSON(RESUMES_FILE); }
function saveResumes(r) { writeJSON(RESUMES_FILE, r); }
function loadJobs() { return readJSON(JOBS_FILE); }
function saveJobs(j) { writeJSON(JOBS_FILE, j); }

function makeToken(userId) {
    return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

// ============ Auth Middleware ============
function authenticate(req, res, next) {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: '请先登录' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch {
        return res.status(401).json({ error: '登录已过期，请重新登录' });
    }
}

// ============ Auth Routes ============
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, email, phone, password } = req.body;
        if (!username || username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名需2-20个字符' });
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: '请输入有效邮箱' });
        if (!password || password.length < 6) return res.status(400).json({ error: '密码至少6个字符' });

        const users = loadUsers();
        if (users.find(u => u.email === email)) return res.status(409).json({ error: '该邮箱已被注册' });
        if (phone && users.find(u => u.phone === phone)) return res.status(409).json({ error: '该手机号已被注册' });

        const password_hash = await bcrypt.hash(password, 10);
        const user = { id: Date.now().toString(), username, email, phone: phone || null, password_hash, createdAt: new Date().toISOString() };
        users.push(user);
        saveUsers(users);
        const token = makeToken(user.id);
        res.json({ token, user: { id: user.id, username: user.username, email: user.email, phone: user.phone } });
    } catch (e) {
        console.error('Register error:', e.message);
        res.status(500).json({ error: '注册失败' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { account, password } = req.body;
        if (!account || !password) return res.status(400).json({ error: '请填写所有字段' });

        const users = loadUsers();
        const user = users.find(u => u.email === account) || (account.includes('@') ? null : users.find(u => u.phone === account));
        if (!user) return res.status(401).json({ error: '账号或密码错误' });

        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return res.status(401).json({ error: '账号或密码错误' });

        const token = makeToken(user.id);
        res.json({ token, user: { id: user.id, username: user.username, email: user.email, phone: user.phone } });
    } catch (e) {
        console.error('Login error:', e.message);
        res.status(500).json({ error: '登录失败' });
    }
});

app.get('/api/auth/me', authenticate, (req, res) => {
    const users = loadUsers();
    const user = users.find(u => u.id === req.userId);
    if (!user) return res.status(401).json({ error: '用户不存在' });
    res.json({ id: user.id, username: user.username, email: user.email, phone: user.phone });
});

app.post('/api/auth/logout', (req, res) => {
    res.json({ ok: true });
});

// ============ File Serving ============
app.get('/api/file/:filename', authenticate, (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(UPLOAD_DIR, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    const ext = path.extname(filename).toLowerCase();
    const contentTypes = { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.doc': 'application/msword' };
    res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline');
    fs.createReadStream(filePath).pipe(res);
});

// ============ File Upload ============
app.post('/api/upload', authenticate, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { html, text } = await parseFileToHtml(req.file.path);
    const resumes = loadResumes();
    const resume = {
        id: Date.now().toString(), userId: req.userId,
        name: req.file.originalname.replace(/\.(pdf|docx|doc)$/i, ''),
        type: 'general', content: html,
        filePath: '/uploads/' + req.file.filename,
        isPrimary: true, versions: [], linkedJobId: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    resumes.push(resume);
    saveResumes(resumes);
    res.json({ id: resume.id, filename: req.file.filename, originalName: req.file.originalname, path: '/uploads/' + req.file.filename, size: req.file.size, html, text });
});

app.get('/api/upload/reparse/:filename', authenticate, async (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(UPLOAD_DIR, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    const { html, text } = await parseFileToHtml(filePath);
    res.json({ html, text });
});

// ============ DOCX Export ============
app.post('/api/export/docx', authenticate, async (req, res) => {
    const { originalFilename, suggestions } = req.body;
    if (!originalFilename) return res.status(400).json({ error: 'No filename provided' });
    const filePath = path.join(UPLOAD_DIR, originalFilename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Original file not found' });
    try {
        const buffer = fs.readFileSync(filePath);
        const zip = new PizZip(buffer);
        const xml = zip.file('word/document.xml');
        if (!xml) return res.status(400).json({ error: 'Invalid DOCX' });
        let content = xml.asText();
        for (const s of suggestions) {
            const orig = s.original || '', rew = s.rewritten || '';
            if (!orig || !rew || orig === rew) continue;
            content = content.split(orig).join(rew);
        }
        zip.file('word/document.xml', content);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', 'attachment');
        res.send(zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
    } catch (e) {
        res.status(500).json({ error: 'Export failed: ' + e.message });
    }
});

// ============ PDF Export ============
app.post('/api/export/pdf', authenticate, (req, res) => {
    const { html, filename } = req.body;
    if (!html) return res.status(400).json({ error: 'No HTML content provided' });
    const printHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>body{font-family:'SimSun','宋体',serif;font-size:12pt;line-height:1.8;color:#000;padding:40px 50px;box-sizing:border-box}p{margin:4px 0}table{border-collapse:collapse;width:100%;margin:8px 0}td{padding:2px 6px;border:1px solid #ddd}img{max-width:100%;height:auto}strong{font-weight:bold}h1,h2,h3{font-size:14pt;font-weight:bold;margin:8px 0}.ai-highlight{background:#FEF9C3;border-bottom:2px solid #EAB308}</style></head><body>${html}</body></html>`;
    const name = (filename || 'resume').replace(/\.[^.]+$/, '');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}_print.html"`);
    res.send(printHtml);
});

// ============ AI: Optimize Resume ============
async function zhipuOptimizeResume(resumeContent, jdKeywords, optimizeType) {
    const keywordsStr = jdKeywords && jdKeywords.length > 0 ? '目标岗位关键词: ' + jdKeywords.map(k => k.name).join(', ') + '\n' : '';
    const prompt = optimizeType === 'targeted'
        ? `${keywordsStr}你是一位资深产品经理，擅长优化简历以匹配岗位要求。请从以下简历内容中找出5-10个可以优化的表述，并给出改写建议。只改写简历中实际存在的内容，不要编造任何不存在的信息。简历内容：${resumeContent}请以JSON数组格式返回，格式：[{"id":"1","original":"原文中需要改写的具体句子","rewritten":"改写后的句子","reason":"改写原因","confidence":0.85,"tag":"所属类别"}]`
        : `你是一位资深产品经理，擅长优化简历。请从以下简历内容中找出5-10个可以优化的表述，并给出改写建议。只改写简历中实际存在的内容，不要编造任何不存在的信息。简历内容：${resumeContent}请以JSON数组格式返回，格式：[{"id":"1","original":"原文中需要改写的具体句子","rewritten":"改写后的句子","reason":"改写原因","confidence":0.85,"tag":"所属类别"}]`;
    try {
        const response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + process.env.ZHIPU_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'glm-4-flash', messages: [{ role: 'user', content: prompt }], temperature: 0.3 })
        });
        const data = await response.json();
        const text = data.choices?.[0]?.message?.content || '';
        let cleaned = text.trim();
        if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
        let parsed;
        try { parsed = JSON.parse(cleaned); } catch { try { parsed = JSON.parse(cleaned.replace(/,\s*\]/g, ']').replace(/,\s*\}/g, '}')); } catch { return []; } }
        if (Array.isArray(parsed)) return parsed;
        if (Array.isArray(parsed?.[0]?.changes)) return parsed[0].changes;
        if (Array.isArray(parsed?.changes)) return parsed.changes;
        return [];
    } catch (e) { console.error('LLM error:', e.message); return []; }
}

app.post('/api/ai/optimize-resume', authenticate, async (req, res) => {
    const { resumeContent, jdKeywords, optimizeType } = req.body;
    if (!resumeContent) return res.status(400).json({ error: 'No resume content' });
    const textOnly = resumeContent.replace(/<img[^>]+>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const suggestions = await zhipuOptimizeResume(textOnly, jdKeywords || [], optimizeType || 'general');
    res.json({ suggestions });
});

// ============ AI: Parse JD ============
async function zhipuParseJD(jd) {
    const prompt = `你是一位资深HR，擅长从产品经理岗位描述中精准提取硬技能关键词。严格提取要求：1. 仅提取核心硬技能名词，最多10个，禁止超出2. 只提取可验证的硬技能：具体工具名称（如SQL、Figma、Axure、XMind）、技术概念（如RAG、Agent、机器学习、Prompt）、行业术语（如GMV、DAU、AARRR、ARPU）3. 只提取明确的行业经验：如"电商"、"金融"、"AI/大模型"、"B端"、"SaaS"、"内容社区"等4. 只提取具体的职能要求：如"需求分析"、"数据分析"、"PRD撰写"、"用户调研"、"项目管理"严格禁止：软性描述、学历要求、泛泛之词。请从以下JD中提取不超过10个最重要的硬技能关键词。JD内容：${jd}请以JSON数组格式返回，最多10项，格式：[{"id":"1","name":"关键词名称","category":"类别"}]`;
    try {
        const response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + process.env.ZHIPU_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'glm-4-flash', messages: [{ role: 'user', content: prompt }], temperature: 0.15 })
        });
        const data = await response.json();
        const text = data.choices?.[0]?.message?.content || '';
        let cleaned = text.trim();
        if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
        let parsed;
        try { parsed = JSON.parse(cleaned); } catch { return []; }
        if (!Array.isArray(parsed)) return [];
        return parsed.slice(0, 10);
    } catch (e) { return []; }
}

app.post('/api/ai/parse-jd', authenticate, async (req, res) => {
    const { jd } = req.body;
    if (!jd) return res.status(400).json({ error: 'No JD provided' });
    res.json({ tags: await zhipuParseJD(jd) });
});

// ============ Resumes CRUD ============
app.get('/api/resumes', authenticate, (req, res) => {
    const all = loadResumes().filter(r => r.userId === req.userId);
    all.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 15));
    const offset = (page - 1) * limit;
    res.json({ items: all.slice(offset, offset + limit), total: all.length, page, limit, pages: Math.ceil(all.length / limit) });
});

app.post('/api/resumes', authenticate, (req, res) => {
    const resumes = loadResumes();
    const resume = { id: Date.now().toString(), userId: req.userId, ...req.body, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    resumes.push(resume);
    saveResumes(resumes);
    res.json(resume);
});

app.put('/api/resumes/:id', authenticate, (req, res) => {
    const resumes = loadResumes();
    const idx = resumes.findIndex(r => r.id === req.params.id && r.userId === req.userId);
    if (idx === -1) return res.status(404).json({ error: '简历不存在' });
    resumes[idx] = { ...resumes[idx], ...req.body, updatedAt: new Date().toISOString() };
    saveResumes(resumes);
    res.json(resumes[idx]);
});

app.delete('/api/resumes/:id', authenticate, (req, res) => {
    let resumes = loadResumes();
    const idx = resumes.findIndex(r => r.id === req.params.id && r.userId === req.userId);
    if (idx === -1) return res.status(404).json({ error: '简历不存在' });
    resumes.splice(idx, 1);
    saveResumes(resumes);
    res.json({ ok: true });
});

// ============ Stats ============
app.get('/api/stats', authenticate, (req, res) => {
    const resumes = loadResumes().filter(r => r.userId === req.userId);
    const jobs = loadJobs().filter(j => j.userId === req.userId);
    const counts = { screening: 0, firstInterview: 0, finalInterview: 0, offer: 0 };
    jobs.forEach(j => {
        if (j.status === 'pending' || j.status === 'applied') counts.screening++;
        else if (j.status === 'interviewing') counts.firstInterview++;
        else if (j.status === 'final') counts.finalInterview++;
        else if (j.status === 'offer' || j.status === 'offer_received') counts.offer++;
    });
    res.json({ monthlyApplications: 0, totalResumes: resumes.length, ...counts });
});

app.get('/api/trends', authenticate, (req, res) => {
    const days = parseInt(req.query.days) || 7;
    const jobs = loadJobs().filter(j => j.userId === req.userId);
    const now = new Date();
    const labels = [];
    const applications = [];
    const interviews = [];
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const dateStr = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        labels.push(dateStr);
        const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
        const dayJobs = jobs.filter(j => {
            const created = new Date(j.createdAt);
            return created >= dayStart && created < dayEnd;
        });
        applications.push(dayJobs.length);
        const dayInterviews = dayJobs.filter(j => j.status === 'interviewing' || j.status === 'final').length;
        interviews.push(dayInterviews);
    }
    res.json({ labels, applications, interviews });
});

// ============ Jobs CRUD ============
app.get('/api/jobs', authenticate, (req, res) => {
    res.json(loadJobs().filter(j => j.userId === req.userId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.post('/api/jobs', authenticate, (req, res) => {
    const jobs = loadJobs();
    const job = { id: Date.now().toString(), userId: req.userId, ...req.body, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    jobs.push(job);
    saveJobs(jobs);
    res.status(201).json(job);
});

app.get('/api/jobs/:id', authenticate, (req, res) => {
    const job = loadJobs().find(j => j.id === req.params.id && j.userId === req.userId);
    if (!job) return res.status(404).json({ error: 'Not found' });
    res.json(job);
});

app.put('/api/jobs/:id', authenticate, (req, res) => {
    const jobs = loadJobs();
    const idx = jobs.findIndex(j => j.id === req.params.id && j.userId === req.userId);
    if (idx === -1) return res.status(404).json({ error: '岗位不存在' });
    jobs[idx] = { ...jobs[idx], ...req.body, updatedAt: new Date().toISOString() };
    saveJobs(jobs);
    res.json(jobs[idx]);
});

app.delete('/api/jobs/:id', authenticate, (req, res) => {
    let jobs = loadJobs();
    const idx = jobs.findIndex(j => j.id === req.params.id && j.userId === req.userId);
    if (idx === -1) return res.status(404).json({ error: '岗位不存在' });
    jobs.splice(idx, 1);
    saveJobs(jobs);
    res.json({ ok: true });
});

// ============ Funnel ============
app.get('/api/funnel', authenticate, (req, res) => {
    const jobs = loadJobs().filter(j => j.userId === req.userId);
    const counts = { screening: 0, firstInterview: 0, finalInterview: 0, offer: 0 };
    jobs.forEach(j => {
        if (j.status === 'pending' || j.status === 'applied') counts.screening++;
        else if (j.status === 'interviewing') counts.firstInterview++;
        else if (j.status === 'final') counts.finalInterview++;
        else if (j.status === 'offer' || j.status === 'offer_received') counts.offer++;
    });
    res.json(counts);
});

// ============ Static Files ============
app.use(express.static(path.join(__dirname, 'public')));

// ============ Helpers ============
async function parseFileToHtml(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.docx' || ext === '.doc') {
        try {
            const result = await mammoth.convertToHtml({ path: filePath }, {
                convertImage: mammoth.images.inline(function(el) {
                    return el.read('base64').then(function(buf) {
                        return { src: 'data:' + el.contentType + ';base64,' + buf };
                    });
                })
            });
            const text = cleanText(result.value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
            return { html: result.value, text };
        } catch (e) {
            console.error('DOCX error:', e.message);
            try {
                const raw = await mammoth.extractRawText({ path: filePath });
                const text = cleanText(raw.value);
                return { html: '<p>' + text.replace(/\n/g, '</p><p>') + '</p>', text };
            } catch { return { html: '', text: '' }; }
        }
    } else if (ext === '.pdf') {
        try {
            const dataBuffer = fs.readFileSync(filePath);
            const uint8Array = Buffer.isBuffer(dataBuffer) ? new Uint8Array(dataBuffer) : dataBuffer;
            const parser = new PDFParse({ data: uint8Array });
            const result = await parser.getText();
            const text = cleanText(result && result.text ? result.text : '');
            await parser.destroy();
            if (!text) return { html: '', text: '' };
            const paragraphs = text.split(/\n{2,}/).filter(p => p.trim());
            const html = paragraphs.map(p => '<p>' + escapeHtml(p.trim()).replace(/\n/g, '<br/>') + '</p>').join('');
            return { html, text };
        } catch (e) { console.error('PDF error:', e.message); return { html: '', text: '' }; }
    }
    return { html: '', text: '' };
}

function cleanText(str) { return str ? str.replace(/[\ud800-\udfff]/g, '').trim() : ''; }
function escapeHtml(str) { return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

app.listen(PORT, () => { console.log('JobPilot running on http://localhost:' + PORT); });
