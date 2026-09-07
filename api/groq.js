// Función serverless para Vercel: /api/groq
// La key de Groq se lee de las Variables de Entorno del proyecto y NUNCA se expone al navegador.
module.exports = async (req, res) => {
  const key = process.env.GROQ_API_KEY || '';
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (!key) {
    return res.status(500).json({ error: 'GROQ_API_KEY no configurada en Vercel' });
  }

  try {
    // GET /api/groq?action=models  => lista de modelos
    if (req.query && req.query.action === 'models') {
      const r = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': 'Bearer ' + key },
      });
      return res.status(r.status).json(await r.json());
    }

    // POST /api/groq => chat completions (body = payload de Groq)
    let payload;
    if (typeof req.body === 'string') {
      payload = JSON.parse(req.body);
    } else if (req.body && typeof req.body === 'object') {
      payload = req.body;
    } else {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    }

    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify(payload),
    });
    return res.status(r.status).json(await r.json());
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};