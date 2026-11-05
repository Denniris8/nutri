-- Destructive data migration: removes every saved training plan in the database.
-- The FK cascade removes its vigencies; training records survive with plan_vigencia_id=NULL.
-- Before deployment, create and verify an external MySQL backup of both tables.
-- InnoDB rolls back an interrupted DELETE before COMMIT. After COMMIT, recovery requires
-- a separately reviewed forward migration from that backup; there is no safe in-place rollback.
START TRANSACTION;
DELETE FROM planes_entrenamiento;
COMMIT;
