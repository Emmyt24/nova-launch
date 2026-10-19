import { body, param, query, validationResult } from "express-validator";
import { Request, Response, NextFunction } from "express";
import { WebhookEventType } from "../types/webhook";
import { isValidUrl, isValidStellarAddress } from "../utils/crypto";
import { sendError } from "../utils/response";
import { ErrorCode } from "../lib/errors";

/** Valid campaign types as defined by the on-chain contract */
const CAMPAIGN_TYPES = ["BUYBACK", "AIRDROP", "LIQUIDITY"] as const;

/**
 * Validation middleware to check for errors
 */
export const validate = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendError(res, 400, ErrorCode.VALIDATION_ERROR, "Request validation failed", errors.array());
  }
  next();
};

/**
 * Validation rules for webhook subscription creation
 */
export const validateSubscriptionCreate = [
  body("url")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("URL is required")
    .custom((value) => {
      if (!isValidUrl(value)) {
        throw new Error("Invalid URL format");
      }
      return true;
    }),
  body("tokenAddress")
    .optional({ nullable: true })
    .custom((value) => {
      if (value && !isValidStellarAddress(value)) {
        throw new Error("Invalid Stellar address format");
      }
      return true;
    }),
  body("events")
    .isArray({ min: 1 })
    .withMessage("At least one event type is required")
    .custom((value: string[]) => {
      const validEvents = Object.values(WebhookEventType);
      const invalidEvents = value.filter(
        (e) => !validEvents.includes(e as WebhookEventType)
      );
      if (invalidEvents.length > 0) {
        throw new Error(`Invalid event types: ${invalidEvents.join(", ")}`);
      }
      return true;
    }),
  body("createdBy")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("Creator address is required")
    .custom((value) => {
      if (!isValidStellarAddress(value)) {
        throw new Error("Invalid creator Stellar address");
      }
      return true;
    }),
  validate,
];

/**
 * Validation rules for subscription ID parameter
 */
export const validateSubscriptionId = [
  param("id").isUUID().withMessage("Invalid subscription ID format"),
  validate,
];

/**
 * Validation rules for delivery ID parameter
 */
export const validateDeliveryId = [
  param("id").isUUID().withMessage("Invalid delivery ID format"),
  validate,
];

/**
 * Validation rules for listing subscriptions
 */
export const validateListSubscriptions = [
  body("createdBy")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("Creator address is required")
    .custom((value) => {
      if (!isValidStellarAddress(value)) {
        throw new Error("Invalid creator Stellar address");
      }
      return true;
    }),
  validate,
];

/**
 * Validation rules for campaign creation (POST /api/campaigns).
 *
 * Security notes (OWASP):
 *  - All string inputs are trimmed to prevent whitespace-only values.
 *  - Numeric amounts are validated as non-negative integer strings to avoid
 *    floating-point injection and BigInt parse errors.
 *  - Stellar addresses are validated against the canonical G… format.
 *  - ISO 8601 date strings are validated and endTime must be after startTime.
 *  - metadata is capped at 1 KB to prevent oversized payload attacks.
 */
export const validateCampaignCreate = [
  body("tokenId")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("tokenId is required"),

  body("creator")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("creator is required")
    .custom((value) => {
      if (!isValidStellarAddress(value)) {
        throw new Error("creator must be a valid Stellar address");
      }
      return true;
    }),

  body("type")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("type is required")
    .isIn(CAMPAIGN_TYPES)
    .withMessage(`type must be one of: ${CAMPAIGN_TYPES.join(", ")}`),

  body("targetAmount")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("targetAmount is required")
    .matches(/^\d+$/)
    .withMessage("targetAmount must be a non-negative integer string")
    .custom((value) => {
      if (BigInt(value) <= BigInt(0)) {
        throw new Error("targetAmount must be greater than zero");
      }
      return true;
    }),

  body("startTime")
    .isISO8601()
    .withMessage("startTime must be a valid ISO 8601 date"),

  body("endTime")
    .optional()
    .isISO8601()
    .withMessage("endTime must be a valid ISO 8601 date")
    .custom((value, { req }) => {
      if (value && req.body.startTime) {
        if (new Date(value) <= new Date(req.body.startTime)) {
          throw new Error("endTime must be after startTime");
        }
      }
      return true;
    }),

  body("metadata")
    .optional()
    .isString()
    .withMessage("metadata must be a string")
    .isLength({ max: 1024 })
    .withMessage("metadata must not exceed 1024 characters"),

  validate,
];

/**
 * Validation rules for campaign ID path parameter.
 */
export const validateCampaignId = [
  param("campaignId")
    .isInt({ min: 1 })
    .withMessage("campaignId must be a positive integer"),
  validate,
];

/**
 * Validation rules for campaign execution history query params.
 */
export const validateCampaignExecutionQuery = [
  param("campaignId")
    .isInt({ min: 1 })
    .withMessage("campaignId must be a positive integer"),
  query("limit")
    .optional()
    .isInt({ min: 1, max: 200 })
    .withMessage("limit must be between 1 and 200"),
  query("offset")
    .optional()
    .isInt({ min: 0 })
    .withMessage("offset must be a non-negative integer"),
  validate,
];
