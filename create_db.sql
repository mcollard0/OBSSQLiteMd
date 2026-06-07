CREATE TABLE employees (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    department TEXT NOT NULL,
    salary REAL NOT NULL,
    hire_date TEXT NOT NULL
);

CREATE INDEX idx_department ON employees(department);
CREATE INDEX idx_salary ON employees(salary);

INSERT INTO employees VALUES (1, 'Alice Chen', 'Engineering', 125000, '2022-03-15');
INSERT INTO employees VALUES (2, 'Bob Martinez', 'Marketing', 85000, '2021-06-01');
INSERT INTO employees VALUES (3, 'Carol Davis', 'Engineering', 130000, '2020-11-20');
INSERT INTO employees VALUES (4, 'Dave Wilson', 'Sales', 95000, '2023-01-10');
INSERT INTO employees VALUES (5, 'Eve Johnson', 'Engineering', 140000, '2019-08-05');
INSERT INTO employees VALUES (6, 'Frank Lee', 'Marketing', 78000, '2023-04-22');
INSERT INTO employees VALUES (7, 'Grace Kim', 'Sales', 105000, '2021-09-14');
INSERT INTO employees VALUES (8, 'Hank Brown', 'Engineering', 115000, '2022-07-30');

CREATE TABLE revenue (
    quarter TEXT PRIMARY KEY,
    amount REAL NOT NULL,
    department TEXT NOT NULL
);

INSERT INTO revenue VALUES ('2024-Q1', 1500000, 'Engineering');
INSERT INTO revenue VALUES ('2024-Q2', 1800000, 'Engineering');
INSERT INTO revenue VALUES ('2024-Q3', 950000, 'Marketing');
INSERT INTO revenue VALUES ('2024-Q4', 1200000, 'Sales');
