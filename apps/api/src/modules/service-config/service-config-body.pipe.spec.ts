import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import { UpdateMunicipalityFareDTO, UpdateMunicipalityOperationalParamsDTO } from '@voyyaa/shared';
import { ServiceConfigBodyPipe } from './service-config-body.pipe';

const FARE = {
  version: 3,
  base_fare: 9000,
  night_surcharge_pct: 20,
  holiday_surcharge_pct: 15,
  is_official: false,
};

const PARAMS = {
  version: null,
  search_radius_km: 2,
  expansion_radius_km: 6,
  acceptance_timeout_sec: 15,
  max_auto_retries: 3,
  tiebreak_window_hours: 3,
  location_stale_min: 15,
  avg_speed_kmh: 20,
  cancellation_window_min: 2,
  no_show_grace_min: 5,
};

function run(pipe: ServiceConfigBodyPipe<unknown>, value: unknown): unknown {
  try {
    return pipe.transform(value, { type: 'body' });
  } catch (error) {
    return error;
  }
}

describe('ServiceConfigBodyPipe', () => {
  const farePipe = new ServiceConfigBodyPipe(UpdateMunicipalityFareDTO);
  const paramsPipe = new ServiceConfigBodyPipe(UpdateMunicipalityOperationalParamsDTO);

  it('passes a valid body through', () => {
    expect(run(farePipe, FARE)).toEqual(FARE);
  });

  it('a range failure is a 400 INVALID_DATA with the field', () => {
    const error = run(farePipe, { ...FARE, base_fare: 10 });

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: 'INVALID_DATA',
      details: [expect.objectContaining({ field: 'base_fare' })],
    });
  });

  it('a cross-field failure is a 422 SETTINGS_OUT_OF_RANGE naming the field', () => {
    const error = run(paramsPipe, { ...PARAMS, search_radius_km: 9, expansion_radius_km: 8 });

    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'SETTINGS_OUT_OF_RANGE',
      field: 'search_radius_km',
      message: 'El radio de búsqueda no puede superar el radio de expansión',
    });
  });

  it('a reference on a non-official fare is a 422 on official_reference', () => {
    const error = run(farePipe, { ...FARE, official_reference: 'Decreto 1 de 2026' });

    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'SETTINGS_OUT_OF_RANGE',
      field: 'official_reference',
    });
  });
});
