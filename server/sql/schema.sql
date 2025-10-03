-- Create database (adjust name as you like)
CREATE DATABASE IF NOT EXISTS mltm CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE mltm;


-- Machines catalog
CREATE TABLE IF NOT EXISTS machines (
id INT AUTO_INCREMENT PRIMARY KEY,
code VARCHAR(32) NOT NULL UNIQUE, -- e.g., 'CNC1', 'CNC2'
name VARCHAR(100) NOT NULL -- human readable
) ENGINE=InnoDB;


-- Enumerated status colors
CREATE TABLE IF NOT EXISTS status_colors (
id TINYINT PRIMARY KEY,
name VARCHAR(16) NOT NULL UNIQUE, -- 'green','yellow','red','blue','off'
hex VARCHAR(7) NOT NULL -- '#4CAF50', etc.
);


INSERT IGNORE INTO status_colors (id, name, hex) VALUES
(1,'green','#4CAF50'),
(2,'yellow','#FFC107'),
(3,'red','#F44336'),
(4,'blue','#2196F3'),
(5,'off','#9E9E9E');


-- Status intervals (one row per contiguous period)
CREATE TABLE IF NOT EXISTS machine_status (
id BIGINT AUTO_INCREMENT PRIMARY KEY,
machine_id INT NOT NULL,
color_id TINYINT NOT NULL,
start_time DATETIME NOT NULL,
end_time DATETIME NULL,
CONSTRAINT fk_ms_machine FOREIGN KEY (machine_id) REFERENCES machines(id),
CONSTRAINT fk_ms_color FOREIGN KEY (color_id) REFERENCES status_colors(id),
INDEX ix_ms_machine_time (machine_id, start_time),
INDEX ix_ms_open (machine_id, end_time)
) ENGINE=InnoDB;


-- Optional: simple API keys for device/backfill posting later
CREATE TABLE IF NOT EXISTS api_keys (
id INT AUTO_INCREMENT PRIMARY KEY,
label VARCHAR(64) NOT NULL,
token CHAR(36) NOT NULL UNIQUE,
enabled TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB;