import express from 'express';
import cors from 'cors';
import { ApiLensSDK } from '@apilens/node-sdk';
import productsRouter from './routes/products';
import paymentsRouter from './routes/payments';
import customersRouter from './routes/customers';

const app = express();
const port = process.env.PORT || 4001;

const apilens = new ApiLensSDK({
  serviceName: 'demo-api-server',
  reporterUrl: process.env.APILENS_REPORTER_URL || 'http://localhost:3001',
});

app.use(cors());
app.use(express.json());
app.use(apilens.expressMiddleware());

app.use('/api/products', productsRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/customers', customersRouter);

app.listen(port, () => {
  console.log(`[demo-api-server] Listening on port ${port}`);
});
