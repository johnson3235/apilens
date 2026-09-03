import { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const apiRes = await fetch('http://localhost:4001/api/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-qa-session-id': req.headers['x-qa-session-id'] as string || '',
        'x-test-scenario-id': req.headers['x-test-scenario-id'] as string || '',
        'x-apilens-rules': req.headers['x-apilens-rules'] as string || '',
      },
      body: JSON.stringify(req.body)
    });
    
    const data = await apiRes.json();
    res.status(apiRes.status).json(data);
  } catch (error: unknown) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
