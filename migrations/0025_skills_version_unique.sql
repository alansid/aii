-- C-353 N5：技能版本號唯一（同專案、同名、同版本只能一列），配合 INSERT…SELECT MAX(version)+1
-- 先確認沒有重複版本才建得起來：SELECT project, name, version, COUNT(*) FROM skills GROUP BY 1,2,3 HAVING COUNT(*) > 1;
DROP INDEX IF EXISTS idx_skills_project;
CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_version ON skills (project, name, version);
