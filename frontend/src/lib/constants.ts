/**
 * Pure Milk POS — shared constants.
 */

/**
 * Menu categories for Pure Milk shop.
 * MenuManagement merges this with whatever categories are live in the DB,
 * so adding a new one from the UI never orphans an item.
 */
export const MENU_CATEGORIES = [
  'Milk',
  'Yogurt',
  'Butter & Ghee',
  'Cheese & Paneer',
  'Cream',
  'Flavoured Drinks',
] as const;

export const DEFAULT_CATEGORY = 'Milk';

/** Payment methods offered at checkout. */
export const PAYMENT_METHODS = ['Cash', 'Card', 'Online', 'Credit'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Order types. */
export const ORDER_TYPES = ['Walk-in', 'Delivery'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];
