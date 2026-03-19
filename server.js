const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const pipeline = promisify(require('stream').pipeline);
const PizZip = require('pizzip');
const mammoth = require('mammoth');
const { PDFParse } = require('pdf-parse');

const app = express();
const PORT = process.env.PORT || 3000;

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

// ============ In-memory cache ============
let resumesCache = null;
let cacheTime = 0;
const CACHE_TTL = 30000; // 30 seconds

function loadResumes(forceReload = false) {
    if (!forceReload && resumesCache !== null && Date.now() - cacheTime < CACHE_TTL) {
        return resumesCache;
    }
    const file = path.join(DATA_DIR, 'resumes.json');
    if (!fs.existsSync(file)) {
        resumesCache = [];
        cacheTime = Date.now();
        return [];
    }
    try {
        resumesCache = JSON.parse(fs.readFileSync(file, 'utf-8'));
        cacheTime = Date.now();
        return resumesCache;
    } catch {
        resumesCache = [];
        cacheTime = Date.now();
        return [];
    }
}
function saveResumes(data) {
    fs.writeFileSync(path.join(DATA_DIR, 'resumes.json'), JSON.stringify(data, null, 2), 'utf-8');
    resumesCache = data;
    cacheTime = Date.now();
}
function invalidateCache() {
    resumesCache = null;
}

async function parseFileToHtml(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.docx' || ext === '.doc') {
        try {
            const result = await mammoth.convertToHtml({ path: filePath }, {
                convertImage: mammoth.images.inline(function(element) {
                    return element.read('base64').then(function(imageBuffer) {
                        return { src: 'data:' + element.contentType + ';base64,' + imageBuffer };
                    });
                })
            });
            const text = cleanText(result.value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
            console.log('DOCX parsed: html length', result.value.length, 'text length', text.length);
            return { html: result.value, text };
        } catch (e) {
            console.error('DOCX mammoth error:', e.message);
            try {
                const raw = await mammoth.extractRawText({ path: filePath });
                const text = cleanText(raw.value);
                return { html: '<p>' + text.replace(/\n/g, '</p><p>') + '</p>', text };
            } catch (e2) {
                console.error('DOCX fallback error:', e2.message);
                return { html: '', text: '' };
            }
        }
    } else if (ext === '.pdf') {
        try {
            const dataBuffer = fs.readFileSync(filePath);
            const uint8Array = Buffer.isBuffer(dataBuffer) ? new Uint8Array(dataBuffer) : dataBuffer;
            const parser = new PDFParse({ data: uint8Array });
            const result = await parser.getText();
            console.log('PDF parsed: text length', (result && result.text ? result.text.length : 0), 'pages', result ? result.total : 0);
            const text = cleanText(result && result.text ? result.text : '');
            await parser.destroy();
            if (!text) return { html: '', text: '' };
            const paragraphs = text.split(/\n{2,}/).filter(p => p.trim());
            const html = paragraphs.map(p => '<p>' + escapeHtml(p.trim()).replace(/\n/g, '<br/>') + '</p>').join('');
            return { html, text };
        } catch (e) {
            console.error('PDF parse error:', e.message);
            return { html: '', text: '' };
        }
    }
    return { html: '', text: '' };
}

function cleanText(str) {
    if (!str) return '';
    return str.replace(/[\ud800-\udfff]/g, '').trim();
}

function escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// --- File serving ---
app.get('/api/file/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(UPLOAD_DIR, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    const ext = path.extname(filename).toLowerCase();
    const contentTypes = { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.doc': 'application/msword' };
    res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline');
    fs.createReadStream(filePath).pipe(res);
});

// --- File upload with HTML extraction ---
app.post('/api/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { html, text } = await parseFileToHtml(req.file.path);

    resumesCache = null;
    cacheTime = 0;
    const resumes = loadResumes(true);
    const resume = {
        id: Date.now().toString(),
        name: req.file.originalname.replace(/\.(pdf|docx|doc)$/i, ''),
        type: 'general',
        content: html,
        filePath: '/uploads/' + req.file.filename,
        isPrimary: true,
        versions: [],
        linkedJobId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    resumes.push(resume);
    saveResumes(resumes);
    console.log('Upload saved resume id:', resume.id, 'total resumes:', resumes.length);

    res.json({
        id: resume.id,
        filename: req.file.filename,
        originalName: req.file.originalname,
        path: '/uploads/' + req.file.filename,
        size: req.file.size,
        html, text
    });
});

// --- Re-parse file from disk ---
app.get('/api/upload/reparse/:filename', async (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(UPLOAD_DIR, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    const { html, text } = await parseFileToHtml(filePath);
    res.json({ html, text });
});

// --- DOCX export with in-place text replacement ---
app.post('/api/export/docx', async (req, res) => {
    const { originalFilename, suggestions } = req.body;
    if (!originalFilename) return res.status(400).json({ error: 'No filename provided' });
    const filePath = path.join(UPLOAD_DIR, originalFilename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Original file not found' });

    try {
        const buffer = fs.readFileSync(filePath);
        const zip = new PizZip(buffer);
        const xml = zip.file('word/document.xml');
        if (!xml) return res.status(400).json({ error: 'Invalid DOCX: no document.xml' });

        let content = xml.asText();
        for (const s of suggestions) {
            const orig = s.original || '';
            const rew = s.rewritten || '';
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

// --- PDF export from HTML content ---
app.post('/api/export/pdf', (req, res) => {
    const { html, filename } = req.body;
    if (!html) return res.status(400).json({ error: 'No HTML content provided' });

    const printHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>
body { font-family: 'SimSun', '宋体', serif; font-size: 12pt; line-height: 1.8; color: #000; padding: 40px 50px; box-sizing: border-box; }
p { margin: 4px 0; }
table { border-collapse: collapse; width: 100%; margin: 8px 0; }
td { padding: 2px 6px; border: 1px solid #ddd; }
img { max-width: 100%; height: auto; }
strong { font-weight: bold; }
h1, h2, h3 { font-size: 14pt; font-weight: bold; margin: 8px 0; }
.ai-highlight { background: #FEF9C3; border-bottom: 2px solid #EAB308; }
@media print { body { padding: 0; } }
</style></head><body>${html}</body></html>`;

    const name = (filename || 'resume').replace(/\.[^.]+$/, '');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}_print.html"`);
    res.send(printHtml);
});

// --- AI: Optimize resume ---
async function zhipuOptimizeResume(resumeContent, jdKeywords, optimizeType) {
    const keywordsStr = jdKeywords && jdKeywords.length > 0
        ? '目标岗位关键词: ' + jdKeywords.map(k => k.name).join(', ') + '\n'
        : '';

    const prompt = optimizeType === 'targeted'
        ? `${keywordsStr}你是一位资深产品经理，擅长优化简历以匹配岗位要求。
请从以下简历内容中找出5-10个可以优化的表述，并给出改写建议。只改写简历中实际存在的内容，不要编造任何不存在的信息。
简历内容：
${resumeContent}

请以JSON数组格式返回，格式：
[{"id":"1","original":"原文中需要改写的具体句子","rewritten":"改写后的句子","reason":"改写原因","confidence":0.85,"tag":"所属类别"}]`
        : `你是一位资深产品经理，擅长优化简历。
请从以下简历内容中找出5-10个可以优化的表述，并给出改写建议。只改写简历中实际存在的内容，不要编造任何不存在的信息。
简历内容：
${resumeContent}

请以JSON数组格式返回，格式：
[{"id":"1","original":"原文中需要改写的具体句子","rewritten":"改写后的句子","reason":"改写原因","confidence":0.85,"tag":"所属类别"}]`;

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
    } catch (e) {
        console.error('LLM error:', e.message);
        return [];
    }
}

app.post('/api/ai/optimize-resume', async (req, res) => {
    const { resumeContent, jdKeywords, optimizeType } = req.body;
    if (!resumeContent) return res.status(400).json({ error: 'No resume content' });
    const suggestions = await zhipuOptimizeResume(resumeContent, jdKeywords || [], optimizeType || 'general');
    res.json({ suggestions });
});

// --- AI: Parse JD (strict 10 keywords, no water words) ---
async function zhipuParseJD(jd) {
    const prompt = `你是一位资深HR，擅长从产品经理岗位描述中精准提取硬技能关键词。

严格提取要求：
1. 仅提取核心硬技能名词，最多10个，禁止超出
2. 只提取可验证的硬技能：具体工具名称（如SQL、Figma、Axure、XMind）、技术概念（如RAG、Agent、机器学习、Prompt）、行业术语（如GMV、DAU、AARRR、ARPU）
3. 只提取明确的行业经验：如"电商"、"金融"、"AI/大模型"、"B端"、"SaaS"、"内容社区"等
4. 只提取具体的职能要求：如"需求分析"、"数据分析"、"PRD撰写"、"用户调研"、"项目管理"

严格禁止（出现任何一个直接跳过）：
- 软性描述：性格积极上进、沟通能力强、学习能力强、团队协作、逻辑清晰、责任心强、抗压能力强、自我驱动、执行力强
- 学历要求：本科以上、硕士优先
- 泛泛之词：责任心、主动性、团队精神、抗压能力、独立工作

请从以下JD中提取不超过10个最重要的硬技能关键词。
JD内容：
${jd}

请以JSON数组格式返回，最多10项，格式：
[{"id":"1","name":"关键词名称","category":"类别"}]
类别必须是以下之一：产品能力、技术技能、工具熟练度、行业经验。`;

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
    } catch (e) {
        return [];
    }
}

app.post('/api/ai/parse-jd', async (req, res) => {
    const { jd } = req.body;
    if (!jd) return res.status(400).json({ error: 'No JD provided' });
    const tags = await zhipuParseJD(jd);
    res.json({ tags });
});

// --- Resumes CRUD (with pagination) ---
app.get('/api/resumes', (req, res) => {
    const all = loadResumes();
    console.log('GET /api/resumes: loaded', all.length, 'resumes');
    all.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 15));
    const offset = (page - 1) * limit;
    const total = all.length;
    const items = all.slice(offset, offset + limit);
    res.json({
        items,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
    });
});

app.post('/api/resumes', (req, res) => {
    console.log('POST /api/resumes body keys:', Object.keys(req.body));
    try {
        const resumes = loadResumes(true);
        const resume = {
            id: Date.now().toString(),
            ...req.body,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        resumes.push(resume);
        saveResumes(resumes);
        console.log('Saved resume id:', resume.id, 'total resumes:', resumes.length);
        res.json(resume);
    } catch (e) {
        console.error('POST /api/resumes error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/resumes/:id', (req, res) => {
    console.log('PUT /api/resumes/' + req.params.id, 'body keys:', Object.keys(req.body));
    try {
        const resumes = loadResumes(true);
        const idx = resumes.findIndex(r => r.id === req.params.id);
        if (idx === -1) {
            console.error('Resume not found:', req.params.id);
            return res.status(404).json({ error: 'Not found' });
        }
        resumes[idx] = { ...resumes[idx], ...req.body, updatedAt: new Date().toISOString() };
        saveResumes(resumes);
        console.log('Updated resume:', resumes[idx].id);
        res.json(resumes[idx]);
    } catch (e) {
        console.error('PUT /api/resumes error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/resumes/:id', (req, res) => {
    let resumes = loadResumes(true);
    resumes = resumes.filter(r => r.id !== req.params.id);
    saveResumes(resumes);
    res.json({ ok: true });
});

// --- Stats ---
app.get('/api/stats', (req, res) => {
    const resumes = loadResumes();
    res.json({ monthlyApplications: 0, totalResumes: resumes.length });
});

// ============ Jobs CRUD ============
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
function loadJobs() {
    if (!fs.existsSync(JOBS_FILE)) { fs.writeFileSync(JOBS_FILE, '[]', 'utf-8'); return []; }
    try { return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf-8')); } catch { return []; }
}
function saveJobs(jobs) { fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2), 'utf-8'); }

app.get('/api/jobs', (req, res) => {
    const jobs = loadJobs();
    console.log('GET /api/jobs returning', jobs.length, 'jobs');
    res.json(jobs);
});

app.post('/api/jobs', (req, res) => {
    try {
        console.log('POST /api/jobs body:', JSON.stringify(req.body).slice(0, 200));
        const jobs = loadJobs();
        const job = { id: Date.now().toString(), ...req.body, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        jobs.push(job);
        saveJobs(jobs);
        console.log('Saved job id:', job.id, 'total jobs:', jobs.length);
        res.status(201).json(job);
    } catch (e) {
        console.error('POST /api/jobs error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/jobs/:id', (req, res) => {
    const jobs = loadJobs();
    const job = jobs.find(j => j.id === req.params.id);
    if (!job) return res.status(404).json({ error: 'Not found' });
    res.json(job);
});

app.put('/api/jobs/:id', (req, res) => {
    const jobs = loadJobs();
    const idx = jobs.findIndex(j => j.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    jobs[idx] = { ...jobs[idx], ...req.body, updatedAt: new Date().toISOString() };
    saveJobs(jobs);
    res.json(jobs[idx]);
});

app.delete('/api/jobs/:id', (req, res) => {
    let jobs = loadJobs();
    const idx = jobs.findIndex(j => j.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    jobs.splice(idx, 1);
    saveJobs(jobs);
    res.json({ ok: true });
});

// ============ Funnel ============
app.get('/api/funnel', (req, res) => {
    const jobs = loadJobs();
    const counts = { screening: 0, firstInterview: 0, finalInterview: 0, offer: 0 };
    jobs.forEach(j => {
    if (j.status === 'pending' || j.status === 'applied') counts.screening++;
    else if (j.status === 'interviewing') counts.firstInterview++;
        else if (j.status === 'final') counts.finalInterview++;
        else if (j.status === 'offer' || j.status === 'offer_received') counts.offer++;
    });
    res.json(counts);
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
    console.log('JobPilot server running on http://localhost:' + PORT);
});
