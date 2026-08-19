import { Router } from 'express';

const router = Router();

const customers = [
  { id: '1', name: 'Alice Smith', email: 'alice@example.com', address: '123 Main St', memberSince: '2023-01-15' },
  { id: '2', name: 'Bob Jones', email: 'bob@example.com', address: '456 Elm St', memberSince: '2022-11-02' },
];

router.get('/', (req, res) => {
  res.json(customers);
});

router.get('/:id', (req, res) => {
  const customer = customers.find(c => c.id === req.params.id);
  if (customer) {
    res.json(customer);
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

export default router;
