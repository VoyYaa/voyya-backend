import { Prisma } from '@prisma/client';
import { summarizeError, toSafeErrorFields } from './safe-error';

const ROW =
  'Failing row contains (41, Carrera 21 #14-33 Barrio La Esperanza, 6.96123417, -75.41759902, 482913)';

function unknownRequestError(): Prisma.PrismaClientUnknownRequestError {
  return new Prisma.PrismaClientUnknownRequestError(
    `\nInvalid \`prisma.tripRequest.update()\` invocation:\n\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23514", message: "new row for relation \\"trip_request\\" violates check constraint \\"trip_request_location_purge_consistent\\"", severity: "ERROR", detail: Some("${ROW}."), column: None, hint: None }), transient: false })`,
    { clientVersion: '5.22.0' },
  );
}

function rawQueryError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Raw query failed. Code: \`23514\`. Message: \`ERROR: new row for relation "trip_request" violates check constraint "trip_request_x"\nDETAIL: ${ROW}.\``,
    {
      code: 'P2010',
      clientVersion: '5.22.0',
      meta: {
        code: '23514',
        message: `ERROR: new row for relation "trip_request" violates check constraint "trip_request_x"\nDETAIL: ${ROW}.`,
      },
    },
  );
}

describe('toSafeErrorFields', () => {
  it('keeps only the name, code, SQLSTATE and constraint of an unknown Prisma request error', () => {
    expect(toSafeErrorFields(unknownRequestError())).toEqual({
      name: 'PrismaClientUnknownRequestError',
      sqlstate: '23514',
      constraint: 'trip_request_location_purge_consistent',
    });
  });

  it('keeps only the name, code, SQLSTATE and constraint of a raw query error', () => {
    expect(toSafeErrorFields(rawQueryError())).toEqual({
      name: 'PrismaClientKnownRequestError',
      prisma_code: 'P2010',
      sqlstate: '23514',
      constraint: 'trip_request_x',
    });
  });

  it('reads the target of a unique violation as the constraint', () => {
    const error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`phone`)', {
      code: 'P2002',
      clientVersion: '5.22.0',
      meta: { modelName: 'User', target: ['phone'] },
    });
    expect(toSafeErrorFields(error)).toEqual({
      name: 'PrismaClientKnownRequestError',
      prisma_code: 'P2002',
      constraint: 'phone',
    });
  });

  it('ignores a meta value that is not an identifier', () => {
    const error = new Prisma.PrismaClientKnownRequestError('x', {
      code: 'P2003',
      clientVersion: '5.22.0',
      meta: { field_name: 'Calle 5 #12-34 (centro)' },
    });
    expect(toSafeErrorFields(error)).toEqual({
      name: 'PrismaClientKnownRequestError',
      prisma_code: 'P2003',
    });
  });

  it('never carries the message of a validation error, which echoes the submitted data', () => {
    const error = new Prisma.PrismaClientValidationError(
      'Invalid `prisma.tripRequest.create()` invocation: { data: { pickupAddress: "Carrera 21 #14-33" } }',
      { clientVersion: '5.22.0' },
    );
    expect(JSON.stringify(toSafeErrorFields(error))).not.toContain('Carrera 21');
  });

  it('redacts personal data in the message and stack of a generic error', () => {
    const error = new Error('SMS failed for 300 111 2233');
    const fields = toSafeErrorFields(error);
    expect(fields.message).toBe('SMS failed for [phone]');
    expect(fields.stack).not.toContain('300 111 2233');
  });

  it('redacts a non-error value', () => {
    expect(toSafeErrorFields('boom 300 111 2233')).toEqual({
      name: 'NonError',
      message: 'boom [phone]',
    });
  });
});

describe('summarizeError', () => {
  it('summarizes a Prisma error without message or meta', () => {
    expect(summarizeError(rawQueryError())).toBe(
      'PrismaClientKnownRequestError prisma_code=P2010 sqlstate=23514 constraint=trip_request_x',
    );
  });

  it('returns the redacted message of a generic error', () => {
    expect(summarizeError(new Error('Key (a)=(secret) already exists.'))).toBe(
      'Key ([redacted])=([redacted]) already exists.',
    );
  });
});
