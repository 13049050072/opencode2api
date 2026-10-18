package config

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
)

// SaveAtomic writes cfg to path as indented JSON, after clearing the resolved
// proxy list (see PasswordForSave). It does not normalize cfg; callers pass a
// config that Normalize already accepted. An existing file is kept as
// path+".bak".
//
// The data is written and synced to a temporary file created beside the
// target, so the final rename stays on the same filesystem; the temporary
// file takes over the existing file's permission bits. Outside Windows the
// backup is a copy and the rename replaces path atomically. On Windows it
// takes two renames instead, path to the backup and then the temporary file
// to path, so path is briefly absent; if the second rename fails, the backup
// is moved back.
func SaveAtomic(path string, cfg Config) error {
	cfg.PasswordForSave()
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	data = append(data, '\n')
	dir := filepath.Dir(path)
	temp, err := os.CreateTemp(dir, ".config-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary config: %w", err)
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if _, err = temp.Write(data); err == nil {
		err = temp.Sync()
	}
	closeErr := temp.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("write temporary config: %w", err)
	}
	if info, statErr := os.Stat(path); statErr == nil {
		_ = os.Chmod(tempPath, info.Mode().Perm())
	}

	backup := path + ".bak"
	if runtime.GOOS == "windows" {
		_ = os.Remove(backup)
		if _, statErr := os.Stat(path); statErr == nil {
			if err := os.Rename(path, backup); err != nil {
				return fmt.Errorf("backup config: %w", err)
			}
		}
		if err := os.Rename(tempPath, path); err != nil {
			_ = os.Rename(backup, path)
			return fmt.Errorf("replace config: %w", err)
		}
		return nil
	}
	if _, statErr := os.Stat(path); statErr == nil {
		if err := copyFile(path, backup); err != nil {
			return fmt.Errorf("backup config: %w", err)
		}
	}
	if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("replace config: %w", err)
	}
	return nil
}

// copyFile copies source to target, truncating target, and preserves source's
// permission bits. The copy is synced before target is closed.
func copyFile(source, target string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	mode := os.FileMode(0600)
	if info, statErr := in.Stat(); statErr == nil {
		mode = info.Mode().Perm()
	}
	out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	_ = out.Chmod(mode)
	_, copyErr := io.Copy(out, in)
	syncErr := out.Sync()
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}
