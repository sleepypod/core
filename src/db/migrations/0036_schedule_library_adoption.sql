-- Startup adopts compatible calendar schedules once without rewriting rows.
-- Imported bedtime routines keep their independent ownership and are excluded.
CREATE TABLE schedule_library_adoption (pending INTEGER NOT NULL);
--> statement-breakpoint
INSERT INTO schedule_library_adoption (pending) VALUES (1);
