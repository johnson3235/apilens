import { NextApiRequest, NextApiResponse } from 'next';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({
    items: [
      { productId: "1", name: "Widget Pro", quantity: 2, price: 29.99 }
    ],
    total: 59.98
  });
}
