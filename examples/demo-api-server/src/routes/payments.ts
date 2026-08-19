import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

router.post('/', async (req, res) => {
  const { amount, currency = 'USD', customerId } = req.body;

  if (!amount || !customerId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Simulate payment processing delay (200-500ms)
  const delay = Math.floor(Math.random() * 300) + 200;
  await new Promise(resolve => setTimeout(resolve, delay));

  res.json({
    id: uuidv4(),
    status: 'completed',
    amount,
    currency,
    timestamp: new Date().toISOString()
  });
});

export default router;
