/**
 * Orders to check the order parser against: what a customer types, and the
 * drinks that should come out. Run against real Jev by
 * `orders.live.test.ts` (skipped without a key).
 *
 * A drink is written as one cup, `drink` then any modifier the customer
 * stated: `cappuccino milk=almond`, `latte milk=oat size=large`, `mocha decaf
 * iced`. Two of the same drink are two entries. Order does not matter.
 */
import type { Intent } from '../lib/types';

export interface OrderCase {
  text: string;
  intent?: Intent;
  /** One entry per cup; order does not matter. */
  cups: string[];
  /** Why this case is here, or a limit it is known to hit. */
  note?: string;
}

export const ORDERS: OrderCase[] = [
  // One drink.
  { text: 'a latte', cups: ['latte'] },
  { text: 'one espresso please', cups: ['espresso'] },
  { text: 'can I get a small hot chocolate', cups: ['hot_chocolate size=small'] },
  { text: 'a large oat latte', cups: ['latte milk=oat size=large'] },
  { text: 'a flat white with oat milk', cups: ['flat_white milk=oat'] },
  { text: 'an iced decaf mocha with soy milk', cups: ['mocha milk=soy decaf iced'] },

  // Several drinks.
  { text: 'an espresso and a hot chocolate', cups: ['espresso', 'hot_chocolate'] },
  { text: 'a cortado with oat milk and a macchiato', cups: ['cortado milk=oat', 'macchiato'] },
  { text: 'two flat whites', cups: ['flat_white', 'flat_white'] },
  { text: 'two lattes and a mocha', cups: ['latte', 'latte', 'mocha'] },

  // The same drink twice, made differently.
  {
    text: 'a cap with almond milk and an espresso and a cap with whole milk',
    cups: ['cappuccino milk=almond', 'espresso', 'cappuccino milk=whole'],
    note: 'same drink twice, different milks (read back as "2x espresso (almond), 2x cappuccino (whole)")',
  },
  { text: 'a small latte and a large latte', cups: ['latte size=small', 'latte size=large'] },
  { text: 'an oat latte and a soy latte', cups: ['latte milk=oat', 'latte milk=soy'], note: 'the same drink again, not a detail of the first' },

  // Detail phrases: they add to a drink ordered before them.
  {
    text: 'two caps, one almond and one whole',
    cups: ['cappuccino milk=almond', 'cappuccino milk=whole'],
    note: 'details split the drink before them into cups',
  },
  {
    text: 'two lattes, one with oat milk and one with soy',
    cups: ['latte milk=oat', 'latte milk=soy'],
    note: 'details split the drink before them into cups',
  },
  {
    text: 'three flat whites, one of them decaf',
    cups: ['flat_white decaf', 'flat_white', 'flat_white'],
    note: 'a detail covers one cup; the rest stay as ordered',
  },
  { text: 'an americano, and make it large', cups: ['americano size=large'], note: 'a detail on a single drink' },
  {
    text: 'a latte and a mocha, both large',
    cups: ['latte size=large', 'mocha size=large'],
    note: 'a detail covering more than one cup reaches back to earlier drinks',
  },
  {
    text: 'a latte and a mocha, the latte iced',
    cups: ['latte iced', 'mocha'],
    note: 'a detail that names its drink goes on that drink, not the latest one',
  },
  {
    text: 'two lattes and two mochas, all iced',
    cups: ['latte iced', 'latte iced', 'mocha iced', 'mocha iced'],
    note: 'a detail on every drink, more cups than the quantity question counts to',
  },
  { text: 'a latte then a mocha', cups: ['latte', 'mocha'], note: 'two drinks with no comma or "and" between them' },
  { text: 'a flat white, please', cups: ['flat_white'], note: 'a phrase that is not part of the order' },

  // Not orders.
  { text: "what's the wifi password?", intent: 'question', cups: [] },
  { text: 'cancel my order', intent: 'cancel', cups: [] },
  { text: 'hi there', intent: 'other', cups: [] },
];
