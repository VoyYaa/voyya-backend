import {
  ANDROID_TRIP_UPDATES_CHANNEL_ID,
  PASSENGER_PUSH_NOTIFICATION_TYPES,
  PassengerPushData,
  type PassengerPushNotificationType,
} from '@voyyaa/shared';
import { PASSENGER_PUSH_MESSAGES } from './passenger-push.messages';
import {
  expectedPassengerPushMessage,
  leakedTerms,
  normalizeForSearch,
  SEEDED_IDS,
  SEEDED_TRIP_REQUEST_ID,
  SEEDED_TTL_SEC,
  UX_COPY,
  withoutLegitimateTripId,
} from './passenger-push.fixture';
import { toExpoMessage } from '../transport/expo-push.transport';
import { passengerReplaceKey, toPassengerPushMessage } from './to-passenger-push-message';

const TYPES: readonly PassengerPushNotificationType[] = PASSENGER_PUSH_NOTIFICATION_TYPES;

describe('toPassengerPushMessage (T-1a, content of the PushMessage)', () => {
  it.each(TYPES)('%s -> the exact message of the contract, built from the type and the trip id only', (type) => {
    expect(toPassengerPushMessage(type, SEEDED_TRIP_REQUEST_ID, SEEDED_TTL_SEC)).toEqual(
      expectedPassengerPushMessage(type),
    );
  });

  it.each(TYPES)('%s -> title and body are one of the six UX pairs, by equality', (type) => {
    const message = toPassengerPushMessage(type, SEEDED_TRIP_REQUEST_ID, SEEDED_TTL_SEC);

    expect({ title: message.title, body: message.body }).toEqual(UX_COPY[type]);
  });

  it('there are exactly six notice types and six pairs of copy', () => {
    expect(TYPES).toHaveLength(6);
    expect(Object.keys(PASSENGER_PUSH_MESSAGES).sort()).toEqual([...TYPES].sort());
  });

  it.each(TYPES)('%s -> data is exactly { type, trip_request_id } and parses as the contract', (type) => {
    const { data } = toPassengerPushMessage(type, SEEDED_TRIP_REQUEST_ID, SEEDED_TTL_SEC);

    expect(Object.keys(data).sort()).toEqual(['trip_request_id', 'type']);
    expect(PassengerPushData.safeParse(data).success).toBe(true);
  });

  it.each(TYPES)('%s -> the replace key is exactly trip-<trip_request_id>', (type) => {
    const message = toPassengerPushMessage(type, 4821_77, SEEDED_TTL_SEC);

    expect(message.replaceKey).toBe('trip-482177');
    expect(passengerReplaceKey(482177)).toBe('trip-482177');
  });

  it('all the notices of one trip share the replace key, so the newest replaces the previous one', () => {
    const keys = TYPES.map((type) => toPassengerPushMessage(type, 9, SEEDED_TTL_SEC).replaceKey);

    expect(new Set(keys).size).toBe(1);
  });

  it('uses the channel of the contract, the configured ttl, the default sound and high priority', () => {
    const message = toPassengerPushMessage('trip_driver_arrived', 17, 120);

    expect(message.channelId).toBe(ANDROID_TRIP_UPDATES_CHANNEL_ID);
    expect(message.channelId).toBe('trip-updates');
    expect(message.ttlSec).toBe(120);
    expect(message.sound).toBe('default');
    expect(message.priority).toBe('high');
  });

  it('the message has exactly the fields of the port and nothing else', () => {
    const message = toPassengerPushMessage('trip_no_driver', 17, 300);

    expect(Object.keys(message).sort()).toEqual(
      ['body', 'channelId', 'data', 'priority', 'replaceKey', 'sound', 'title', 'ttlSec'].sort(),
    );
  });

  it.each(TYPES)('%s -> the whole serialized message mentions nothing on the forbidden list', (type) => {
    const message = toPassengerPushMessage(type, SEEDED_TRIP_REQUEST_ID, SEEDED_TTL_SEC);

    expect(leakedTerms(JSON.stringify(message))).toEqual([]);
  });
});

describe('copy of the passenger notices (UX section 1)', () => {
  it.each(TYPES)('%s -> never contains the words código, placa or tarifa, no digits, no emoji', (type) => {
    const text = normalizeForSearch(`${PASSENGER_PUSH_MESSAGES[type].title} ${PASSENGER_PUSH_MESSAGES[type].body}`);

    expect(text).not.toMatch(/codigo|placa|tarifa/);
    expect(text).not.toMatch(/\d/);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it.each(TYPES)('%s -> stays inside the hard ceiling of 40 characters in the title and 100 in the body', (type) => {
    expect(PASSENGER_PUSH_MESSAGES[type].title.length).toBeLessThanOrEqual(40);
    expect(PASSENGER_PUSH_MESSAGES[type].body.length).toBeLessThanOrEqual(100);
  });

  it('only the notice of good news carries an exclamation mark', () => {
    const withExclamation = TYPES.filter((type) =>
      `${PASSENGER_PUSH_MESSAGES[type].title}${PASSENGER_PUSH_MESSAGES[type].body}`.includes('!'),
    );

    expect(withExclamation).toEqual(['trip_driver_assigned']);
  });

  it('the arrival notice says the driver indicates it, not that it is a fact', () => {
    expect(PASSENGER_PUSH_MESSAGES.trip_driver_arrived.title).toContain('indica');
  });

  it('the accepted notice says "aceptó", never "va en camino"', () => {
    expect(PASSENGER_PUSH_MESSAGES.trip_driver_assigned.body).toContain('aceptó');
    expect(normalizeForSearch(JSON.stringify(PASSENGER_PUSH_MESSAGES))).not.toContain('en camino');
  });
});

describe('the forbidden-content scanner itself', () => {
  it('detects a leaked plate, a four-digit code and a coordinate, so a passing run means something', () => {
    expect(leakedTerms('Tu conductor ZKQ-912 llegó')).toContain('zkq-912');
    expect(leakedTerms('Tu código es 4821')).toEqual(expect.arrayContaining(['4821', 'a sequence of four digits']));
    expect(leakedTerms('Estás en 6.9647')).toContain('6.9647');
  });

  it('is insensitive to case and accents', () => {
    expect(leakedTerms('VALERIA')).toContain('valeria');
    expect(leakedTerms('Cootráyal')).toContain('cootrayal');
  });
});

describe('the forbidden-content scanner and the legitimate trip id (D-PP-04)', () => {
  const LONG_IDS = [1000, 4821, 12_345, 2_147_483_647];
  const EXPO_TOKEN = 'ExponentPushToken[ownerphoneAAAAAAAAAA]';

  const serializedForms = (type: PassengerPushNotificationType, tripRequestId: number): string[] => {
    const message = toPassengerPushMessage(type, tripRequestId, SEEDED_TTL_SEC);
    return [JSON.stringify(message), JSON.stringify(toExpoMessage(EXPO_TOKEN, message))];
  };

  describe('the id that the notice legitimately carries is not a leak', () => {
    it.each(LONG_IDS)('trip id %i: every type, as PushMessage and as the message handed to Expo', (tripRequestId) => {
      for (const type of TYPES) {
        for (const serialized of serializedForms(type, tripRequestId)) {
          expect({ type, serialized, leaks: leakedTerms(serialized, tripRequestId) }).toEqual({
            type,
            serialized,
            leaks: [],
          });
        }
      }
    });

    it('a log line with the id of the trip is clean too', () => {
      expect(leakedTerms('[push:passenger] capped tripRequest=4821 type=trip_no_driver', 4821)).toEqual([]);
    });

    it('a real trip id that equals a seeded id is not a leak either', () => {
      for (const seeded of Object.values(SEEDED_IDS)) {
        for (const serialized of serializedForms('trip_driver_assigned', seeded)) {
          expect(leakedTerms(serialized, seeded)).toEqual([]);
        }
      }
    });

    it('without the id argument the seeded trip id keeps working as before', () => {
      expect(leakedTerms(JSON.stringify(expectedPassengerPushMessage('trip_driver_arrived')))).toEqual([]);
    });
  });

  describe('a start code or any other number is still caught', () => {
    it('a four-digit code in the body is a leak even when the trip id also has four digits', () => {
      const message = toPassengerPushMessage('trip_driver_assigned', 4821, SEEDED_TTL_SEC);
      const leaking = JSON.stringify({ ...message, body: `${message.body} Tu código es 7305.` });

      expect(leakedTerms(leaking, 4821)).toEqual(['a sequence of four digits']);
    });

    it('a code that happens to equal the trip id is a leak when it sits in the title or the body', () => {
      const message = toPassengerPushMessage('trip_driver_assigned', 4821, SEEDED_TTL_SEC);
      const inBody = JSON.stringify({ ...message, body: 'Tu código es 4821' });
      const inTitle = JSON.stringify({ ...message, title: '4821' });

      expect(leakedTerms(inBody, 4821)).toEqual(expect.arrayContaining(['4821', 'a sequence of four digits']));
      expect(leakedTerms(inTitle, 4821)).toEqual(expect.arrayContaining(['4821', 'a sequence of four digits']));
    });

    it('a code in the title or the body is caught while the trip id has fewer than four digits', () => {
      const message = toPassengerPushMessage('trip_driver_arrived', 17, SEEDED_TTL_SEC);
      const leaking = JSON.stringify({ ...message, title: `${message.title} 7305` });

      expect(leakedTerms(leaking, 17)).toEqual(['a sequence of four digits']);
    });

    it('only the exact id of the notice is forgiven: another id in data, in the tag or in the collapse id is a leak', () => {
      const message = toPassengerPushMessage('trip_driver_assigned', 4821, SEEDED_TTL_SEC);
      const otherInData = JSON.stringify({ ...message, data: { ...message.data, trip_request_id: 4822 } });
      const otherInTag = JSON.stringify({ ...toExpoMessage(EXPO_TOKEN, message), tag: 'trip-4822' });
      const longerId = JSON.stringify({ ...message, data: { ...message.data, trip_request_id: 48_211 } });

      for (const serialized of [otherInData, otherInTag, longerId]) {
        expect(leakedTerms(serialized, 4821)).toContain('a sequence of four digits');
      }
    });

    it('the id of the passenger, the driver, the assignment or the company is still a leak', () => {
      const message = toPassengerPushMessage('trip_driver_assigned', 4821, SEEDED_TTL_SEC);

      for (const seeded of Object.values(SEEDED_IDS)) {
        const leaking = JSON.stringify({ ...message, body: `${message.body} ${seeded}` });
        expect(leakedTerms(leaking, 4821)).toContain(String(seeded));
      }
    });

    it('forgiving the id does not hide the other forbidden terms in the same text', () => {
      const message = toPassengerPushMessage('trip_driver_assigned', 4821, SEEDED_TTL_SEC);
      const leaking = JSON.stringify({ ...message, body: 'Valeria, tu taxi ZKQ-912 va en camino' });

      expect(leakedTerms(leaking, 4821)).toEqual(expect.arrayContaining(['valeria', 'zkq-912']));
    });
  });

  describe('withoutLegitimateTripId', () => {
    it('removes only the three forms in which the id legitimately appears', () => {
      expect(withoutLegitimateTripId('trip-4821 "trip_request_id":4821 tripRequest=4821 4821', 4821)).toBe(
        'trip-# "trip_request_id":# tripRequest=# 4821',
      );
    });

    it('leaves longer numbers that merely start with the id', () => {
      expect(withoutLegitimateTripId('trip-48211', 4821)).toBe('trip-48211');
    });
  });
});
