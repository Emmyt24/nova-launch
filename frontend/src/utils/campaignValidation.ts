/**
 * Campaign validation utilities
 */

import type { CampaignFormData } from '../types/campaign';

const CAMPAIGN_CONSTRAINTS = {
  title: {
    minLength: 3,
    maxLength: 100,
  },
  description: {
    minLength: 10,
    maxLength: 1000,
  },
  budget: {
    min: 1,
    max: 1000000000, // 1 billion XLM
  },
  duration: {
    min: 3600, // 1 hour in seconds
    max: 31536000, // 1 year in seconds
  },
  slippage: {
    min: 0,
    max: 100,
  },
};

/**
 * Validate campaign title
 */
export function isValidCampaignTitle(title: string): boolean {
  if (!title) return false;
  const trimmed = title.trim();
  return (
    trimmed.length >= CAMPAIGN_CONSTRAINTS.title.minLength &&
    trimmed.length <= CAMPAIGN_CONSTRAINTS.title.maxLength &&
    /^[a-zA-Z0-9\s\-_.,!?()]+$/.test(trimmed)
  );
}

/**
 * Validate campaign description
 */
export function isValidCampaignDescription(description: string): boolean {
  if (!description) return false;
  const trimmed = description.trim();
  return (
    trimmed.length >= CAMPAIGN_CONSTRAINTS.description.minLength &&
    trimmed.length <= CAMPAIGN_CONSTRAINTS.description.maxLength
  );
}

/**
 * Validate budget (in XLM)
 */
export function isValidCampaignBudget(budget: string): boolean {
  try {
    const num = parseFloat(budget);
    if (isNaN(num)) return false;
    return (
      num >= CAMPAIGN_CONSTRAINTS.budget.min &&
      num <= CAMPAIGN_CONSTRAINTS.budget.max &&
      /^\d+(\.\d{1,7})?$/.test(budget) // Max 7 decimals (stroops)
    );
  } catch {
    return false;
  }
}

/**
 * Validate campaign duration (in seconds)
 */
export function isValidCampaignDuration(duration: number): boolean {
  return (
    Number.isInteger(duration) &&
    duration >= CAMPAIGN_CONSTRAINTS.duration.min &&
    duration <= CAMPAIGN_CONSTRAINTS.duration.max
  );
}

/**
 * Validate slippage percentage
 */
export function isValidSlippage(slippage: number): boolean {
  return (
    Number.isFinite(slippage) &&
    slippage >= CAMPAIGN_CONSTRAINTS.slippage.min &&
    slippage <= CAMPAIGN_CONSTRAINTS.slippage.max &&
    slippage % 0.01 === 0 // Allow up to 2 decimal places
  );
}

/**
 * Format duration in seconds to human-readable string
 */
export function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);

  return parts.length > 0 ? parts.join(' ') : '< 1m';
}

/**
 * Parse duration string to seconds
 */
export function parseDurationToSeconds(value: string, unit: 'hours' | 'days' | 'weeks'): number {
  const num = parseFloat(value);
  if (isNaN(num) || num <= 0) return 0;

  const multipliers = {
    hours: 3600,
    days: 86400,
    weeks: 604800,
  };

  return Math.floor(num * multipliers[unit]);
}

/**
 * Validate all campaign form data
 */
export function validateCampaignForm(data: CampaignFormData): {
  valid: boolean;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};

  if (!isValidCampaignTitle(data.title)) {
    errors.title = `Title must be ${CAMPAIGN_CONSTRAINTS.title.minLength}-${CAMPAIGN_CONSTRAINTS.title.maxLength} characters`;
  }

  if (!isValidCampaignDescription(data.description)) {
    errors.description = `Description must be ${CAMPAIGN_CONSTRAINTS.description.minLength}-${CAMPAIGN_CONSTRAINTS.description.maxLength} characters`;
  }

  if (!isValidCampaignBudget(data.budget)) {
    errors.budget = `Budget must be between ${CAMPAIGN_CONSTRAINTS.budget.min} and ${CAMPAIGN_CONSTRAINTS.budget.max} XLM`;
  }

  if (!isValidCampaignDuration(data.duration)) {
    const minHours = CAMPAIGN_CONSTRAINTS.duration.min / 3600;
    const maxDays = CAMPAIGN_CONSTRAINTS.duration.max / 86400;
    errors.duration = `Duration must be between ${minHours} hours and ${maxDays} days`;
  }

  if (!isValidSlippage(data.slippage)) {
    errors.slippage = `Slippage must be between ${CAMPAIGN_CONSTRAINTS.slippage.min}% and ${CAMPAIGN_CONSTRAINTS.slippage.max}%`;
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

/**
 * Get field-specific error message
 */
export function getFieldError(field: keyof CampaignFormData, value: any): string {
  switch (field) {
    case 'title':
      return isValidCampaignTitle(value)
        ? ''
        : `Title must be ${CAMPAIGN_CONSTRAINTS.title.minLength}-${CAMPAIGN_CONSTRAINTS.title.maxLength} characters`;
    case 'description':
      return isValidCampaignDescription(value)
        ? ''
        : `Description must be ${CAMPAIGN_CONSTRAINTS.description.minLength}-${CAMPAIGN_CONSTRAINTS.description.maxLength} characters`;
    case 'budget':
      return isValidCampaignBudget(value)
        ? ''
        : `Budget must be between ${CAMPAIGN_CONSTRAINTS.budget.min} and ${CAMPAIGN_CONSTRAINTS.budget.max} XLM`;
    case 'duration':
      return isValidCampaignDuration(value)
        ? ''
        : `Duration must be between ${CAMPAIGN_CONSTRAINTS.duration.min / 3600} hours and ${CAMPAIGN_CONSTRAINTS.duration.max / 86400} days`;
    case 'slippage':
      return isValidSlippage(value)
        ? ''
        : `Slippage must be between ${CAMPAIGN_CONSTRAINTS.slippage.min}% and ${CAMPAIGN_CONSTRAINTS.slippage.max}%`;
    default:
      return '';
  }
}
