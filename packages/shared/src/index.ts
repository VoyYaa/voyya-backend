// =============================================================================
// @voyya/shared — barrel público.
// Fuente ÚNICA de verdad para backend (NestJS) y frontend (Expo/Vite):
// contratos Zod, DTOs, tipos, catálogos y la máquina de estados del viaje.
// =============================================================================

// Contratos del dominio (ya existentes — se reúsan, NO se redefinen).
export * from './contracts/auth';
export * from './contracts/trips';
export * from './contracts/assignment';

// Máquina de estados del viaje (agrega y reúsa los contratos de arriba).
export * from './domain/trip-state-machine';
