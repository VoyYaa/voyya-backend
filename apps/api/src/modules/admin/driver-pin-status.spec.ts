import { driverPinStatus } from './driver-pin-status';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const delivered = new Date('2026-10-08T10:00:00Z');

describe('driverPinStatus', () => {
  it.each([
    ['not delivered wins over everything', { pinDeliveredAt: null, pinMustChange: true, temporaryPinExpiresAt: new Date(NOW - 1) }, 'not_delivered'],
    ['delivered, still temporary', { pinDeliveredAt: delivered, pinMustChange: true, temporaryPinExpiresAt: new Date(NOW + 1000) }, 'temporary'],
    ['temporary without an expiry date', { pinDeliveredAt: delivered, pinMustChange: true, temporaryPinExpiresAt: null }, 'temporary'],
    ['temporary expired exactly now', { pinDeliveredAt: delivered, pinMustChange: true, temporaryPinExpiresAt: new Date(NOW) }, 'temporary_expired'],
    ['temporary expired in the past', { pinDeliveredAt: delivered, pinMustChange: true, temporaryPinExpiresAt: new Date(NOW - 1000) }, 'temporary_expired'],
    ['personal PIN', { pinDeliveredAt: delivered, pinMustChange: false, temporaryPinExpiresAt: null }, 'personal'],
  ] as const)('%s', (_label, state, expected) => {
    expect(driverPinStatus(state, NOW)).toBe(expected);
  });
});
