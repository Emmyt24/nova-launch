import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { body } from 'express-validator';
import { validate } from '../middleware/validation';
import { successResponse, errorResponse } from '../utils/response';

const router = Router();
const prisma = new PrismaClient();

const MAX_TEXT_LENGTH = 5_000;

/**
 * POST /api/errors
 *
 * Stores a frontend ErrorBoundary report enriched with whatever Stellar
 * transaction context (txHash/ledger/wallet/route) was in flight when the
 * render error was caught. Never accepts or stores private keys, seed
 * phrases, or signed payloads — the body is a fixed whitelist of fields.
 */
router.post(
  '/',
  [
    body('message').isString().notEmpty().isLength({ max: MAX_TEXT_LENGTH }),
    body('stack').optional({ values: 'null' }).isString().isLength({ max: MAX_TEXT_LENGTH }),
    body('componentStack')
      .optional({ values: 'null' })
      .isString()
      .isLength({ max: MAX_TEXT_LENGTH }),
    body('txHash').optional({ values: 'null' }).isString().isLength({ max: 200 }),
    body('ledgerSequence').optional({ values: 'null' }).isInt(),
    body('walletAddress').optional({ values: 'null' }).isString().isLength({ max: 200 }),
    body('route').optional({ values: 'null' }).isString().isLength({ max: 500 }),
    body('network').optional({ values: 'null' }).isString().isLength({ max: 50 }),
    validate,
  ],
  async (req: Request, res: Response) => {
    try {
      const {
        message,
        stack,
        componentStack,
        txHash,
        ledgerSequence,
        walletAddress,
        route,
        network,
      } = req.body;

      const report = await prisma.errorReport.create({
        data: {
          message,
          stack: stack ?? null,
          componentStack: componentStack ?? null,
          txHash: txHash ?? null,
          ledgerSequence: ledgerSequence ?? null,
          walletAddress: walletAddress ?? null,
          route: route ?? null,
          network: network ?? null,
        },
      });

      const correlationId = (req as any).correlationId;
      res.status(201).json(successResponse({ id: report.id }, correlationId));
    } catch (error) {
      console.error('Error storing error report:', error);
      const correlationId = (req as any).correlationId;
      res
        .status(500)
        .json(
          errorResponse({
            code: 'ERROR_REPORT_FAILED',
            message: 'Failed to store error report',
          }, correlationId)
        );
    }
  }
);

export default router;
