USE mltm;


INSERT IGNORE INTO machines (code, name) VALUES
('CNC1','CNC #1'), ('CNC2','CNC #2'), ('CNC3','CNC #3'), ('CNC4','CNC #4');


-- Wipe old demo
DELETE FROM machine_status;


-- Helper: choose day you want to demo (today by default)
-- Set @d := CURDATE(); -- MySQL
SET @d := DATE(NOW());


-- Create a full day timeline for CNC1 with multiple color periods
-- 06:00-10:00 green, 10:00-10:30 yellow, 10:30-12:00 red, 12:00-13:00 off,
-- 13:00-16:30 green, 16:30-17:00 blue, 17:00-24:00 off
INSERT INTO machine_status(machine_id,color_id,start_time,end_time)
SELECT m.id, c.id, CONCAT(@d,' 06:00:00'), CONCAT(@d,' 10:00:00')
FROM machines m JOIN status_colors c ON m.code='CNC1' AND c.name='green';
INSERT INTO machine_status(machine_id,color_id,start_time,end_time)
SELECT m.id, c.id, CONCAT(@d,' 10:00:00'), CONCAT(@d,' 10:30:00')
FROM machines m JOIN status_colors c ON m.code='CNC1' AND c.name='yellow';
INSERT INTO machine_status(machine_id,color_id,start_time,end_time)
SELECT m.id, c.id, CONCAT(@d,' 10:30:00'), CONCAT(@d,' 12:00:00')
FROM machines m JOIN status_colors c ON m.code='CNC1' AND c.name='red';
INSERT INTO machine_status(machine_id,color_id,start_time,end_time)
SELECT m.id, c.id, CONCAT(@d,' 12:00:00'), CONCAT(@d,' 13:00:00')
FROM machines m JOIN status_colors c ON m.code='CNC1' AND c.name='off';
INSERT INTO machine_status(machine_id,color_id,start_time,end_time)
SELECT m.id, c.id, CONCAT(@d,' 13:00:00'), CONCAT(@d,' 16:30:00')
FROM machines m JOIN status_colors c ON m.code='CNC1' AND c.name='green';
INSERT INTO machine_status(machine_id,color_id,start_time,end_time)
SELECT m.id, c.id, CONCAT(@d,' 16:30:00'), CONCAT(@d,' 17:00:00')
FROM machines m JOIN status_colors c ON m.code='CNC1' AND c.name='blue';
-- Keep current status “open” until now (OFF)
INSERT INTO machine_status(machine_id,color_id,start_time,end_time)
SELECT m.id, c.id, CONCAT(@d,' 17:00:00'), NULL
FROM machines m JOIN status_colors c ON m.code='CNC1' AND c.name='off';


-- Copy a lighter pattern for CNC2..4 (optional)
INSERT INTO machine_status(machine_id,color_id,start_time,end_time)
SELECT id, 1, CONCAT(@d,' 07:30:00'), CONCAT(@d,' 11:45:00') FROM machines WHERE code='CNC2';
INSERT INTO machine_status(machine_id,color_id,start_time,end_time)
SELECT id, 5, CONCAT(@d,' 11:45:00'), NULL FROM machines WHERE code='CNC2';


INSERT INTO machine_status(machine_id,color_id,start_time,end_time)
SELECT id, 4, CONCAT(@d,' 08:00:00'), CONCAT(@d,' 12:00:00') FROM machines WHERE code='CNC3';
INSERT INTO machine_status(machine_id,color_id,start_time,end_time)
SELECT id, 1, CONCAT(@d,' 12:00:00'), NULL FROM machines WHERE code='CNC3';


INSERT INTO machine_status(machine_id,color_id,start_time,end_time)
SELECT id, 3, CONCAT(@d,' 09:00:00'), CONCAT(@d,' 10:00:00') FROM machines WHERE code='CNC4';
INSERT INTO machine_status(machine_id,color_id,start_time,end_time)
SELECT id, 5, CONCAT(@d,' 10:00:00'), NULL FROM machines WHERE code='CNC4';