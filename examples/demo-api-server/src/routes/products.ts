import { Router } from 'express';

const router: Router = Router();

const products = [
  { id: '1', name: 'Widget Pro', price: 29.99, description: 'The best widget', inStock: true },
  { id: '2', name: 'Super Gadget', price: 99.00, description: 'Does everything', inStock: true },
  { id: '3', name: 'Thingamajig', price: 4.50, description: 'You need this', inStock: false },
  { id: '4', name: 'Doohickey', price: 12.99, description: 'Classic design', inStock: true },
];

router.get('/', (req, res) => {
  res.json(products);
});

router.get('/:id', (req, res) => {
  const product = products.find(p => p.id === req.params.id);
  if (product) {
    res.json(product);
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

export default router;
