-- Sprint 4：图像编辑（局部重绘 / 消除需要涂抹区域，遮罩以私有文件保存）
ALTER TABLE generation_tasks ADD COLUMN mask_key text;
