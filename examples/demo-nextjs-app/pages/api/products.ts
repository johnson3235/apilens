import { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const apiRes = await fetch('http://localhost:4001/api/products', {
      headers: {
        'x-qa-session-id': req.headers['x-qa-session-id'] as string || '',
        'x-test-scenario-id': req.headers['x-test-scenario-id'] as string || '',
        'x-apilens-rules': req.headers['x-apilens-rules'] as string || '',
      }
    });
    
    const data = await apiRes.json();
    res.status(apiRes.status).json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}
