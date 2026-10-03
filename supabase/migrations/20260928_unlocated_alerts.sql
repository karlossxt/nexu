-- Ejecutar en Supabase antes de desplegar el worker que conserva alertas sin punto.
begin;

alter table public.alerts alter column latitude drop not null;
alter table public.alerts alter column longitude drop not null;
alter table public.alerts drop constraint if exists alerts_location_status_check;
alter table public.alerts add constraint alerts_location_status_check
  check (location_status in ('automatic','approximate','corrected','verified','unlocated'));

commit;
