-- C-353 N5：技能版本號唯一（同專案、同名、同版本只能一列），配合 INSERT…SELECT MAX(version)+1
-- 先建唯一索引：有重複版本會在這句失敗，舊索引還在、什麼都沒改；建好才拿掉舊的一般索引
CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_version ON skills (project, name, version);
DROP INDEX IF EXISTS idx_skills_project;
