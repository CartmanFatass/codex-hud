import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

// Bounds include the reviewed SDK library/peer closure (~8,019 files, 41.2 MB)
// plus compiled HUD sources and their manifest. Client binaries remain excluded.
export const MAX_FILE = 4 * 1024 * 1024;
export const MAX_TOTAL = 96 * 1024 * 1024;
export const MAX_ENTRIES = 12000;
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export function runtime() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (process.platform !== 'linux' || !((major === 22 && minor >= 13) || major === 24))
    throw new Error('requires_linux_node_22_13_or_24');
}
export function relative(name) {
  if (
    typeof name !== 'string' ||
    name.length > 512 ||
    !/^[A-Za-z0-9_@./-]+$/.test(name) ||
    name.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))
  )
    throw new Error('unsafe_relative_path');
  return name;
}
export function identity(stat) {
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode & 0o7777 };
}
export function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
export function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
// Linux directory handles keep operations rooted in the verified directory, including
// when another process renames an ancestor. Never traverse a caller-controlled symlink.
export class Directory {
  constructor(root, privateRoot = false) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root || root === '/')
      throw new Error('existing_canonical_absolute_directory_required');
    this.root = root;
    this.handles = [];
    this.chain = [];
    try {
      let parent = '/';
      for (const part of root.slice(1).split('/')) {
        const named = path.join(parent, part);
        const fd = fs.openSync(named, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        this.handles.push(fd);
        const stat = fs.fstatSync(fd);
        this.chain.push({
          path: this.chain.length ? path.join(this.chain.at(-1).path, part) : '/' + part,
          identity: identity(stat),
        });
        parent = `/proc/self/fd/${fd}`;
      }
      this.fd = this.handles.at(-1);
      this.base = `/proc/self/fd/${this.fd}`;
      const stat = fs.fstatSync(this.fd);
      if (privateRoot && (stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700))
        throw new Error('prefix_must_be_owned_and_private');
      this.assert();
    } catch (error) {
      this.close();
      throw error;
    }
  }
  assert() {
    for (const item of this.chain) {
      const stat = fs.lstatSync(item.path);
      if (!stat.isDirectory() || !same(identity(stat), item.identity)) throw new Error('directory_identity_changed');
    }
  }
  close() {
    for (const fd of this.handles.splice(0).reverse()) fs.closeSync(fd);
  }
  withParent(name, action) {
    relative(name);
    this.assert();
    let parent = this.base;
    const fds = [];
    try {
      const parts = name.split('/');
      const leaf = parts.pop();
      for (const part of parts) {
        const fd = fs.openSync(
          `${parent}/${part}`,
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
        );
        fds.push(fd);
        parent = `/proc/self/fd/${fd}`;
      }
      return action(`${parent}/${leaf}`, parent);
    } finally {
      for (const fd of fds.reverse()) fs.closeSync(fd);
    }
  }
  read(name, limit = MAX_FILE) {
    return this.withParent(name, (file) => {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const before = fs.fstatSync(fd);
        if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw new Error('unsafe_or_oversize_file');
        if ((before.mode & 0o7000) !== 0) throw new Error('unsafe_file_permission_mode');
        const data = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < data.length) {
          const count = fs.readSync(fd, data, offset, data.length - offset, offset);
          if (!count) throw new Error('source_changed_during_read');
          offset += count;
        }
        const after = fs.fstatSync(fd);
        if (
          !same(identity(before), identity(after)) ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          throw new Error('source_changed_during_read');
        const named = fs.lstatSync(file);
        if (!same(identity(named), identity(after)) || named.isSymbolicLink())
          throw new Error('source_replaced_during_read');
        return { data, mode: before.mode & 0o7777, identity: identity(before) };
      } finally {
        fs.closeSync(fd);
      }
    });
  }
  write(name, data, mode = 0o600) {
    if (data.length > MAX_FILE) throw new Error('file_limit');
    return this.withParent(name, (file, parent) => {
      const fd = fs.openSync(
        file,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        mode
      );
      try {
        fs.writeFileSync(fd, data);
        fs.fchmodSync(fd, mode);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      syncDirectory(parent);
    });
  }
  mkdir(name) {
    this.withParent(name, (file, parent) => {
      fs.mkdirSync(file, { mode: 0o700 });
      syncDirectory(parent);
    });
  }
  rename(from, to) {
    this.withParent(from, (source, sourceParent) =>
      this.withParent(to, (target, targetParent) => {
        fs.renameSync(source, target);
        syncDirectory(sourceParent);
        syncDirectory(targetParent);
      })
    );
  }
  unlink(name, directory = false) {
    this.withParent(name, (file, parent) => {
      directory ? fs.rmdirSync(file) : fs.unlinkSync(file);
      syncDirectory(parent);
    });
  }
}
export function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function listNames(directory, limit = MAX_ENTRIES) {
  const names = [];
  const handle = fs.opendirSync(directory);
  try {
    let entry;
    while ((entry = handle.readSync())) {
      if (names.length >= limit) throw new Error('directory_entry_limit');
      names.push(entry.name);
    }
  } finally {
    handle.closeSync();
  }
  return names.sort();
}
export function inventory(directory, allowedFiles) {
  const files = [];
  let directories = 0;
  const fileLimit = MAX_ENTRIES + (allowedFiles?.includes('RUNTIME-MANIFEST.json') ? 1 : 0);
  const directoryLimit = allowedFiles
    ? 1 + allowedFiles.reduce((sum, file) => sum + file.split('/').length - 1, 0)
    : MAX_ENTRIES;
  function walk(base, prefix) {
    if (++directories > directoryLimit) throw new Error('directory_limit');
    for (const name of listNames(base, fileLimit + directoryLimit)) {
      const rel = prefix ? `${prefix}/${name}` : name;
      relative(rel);
      const stat = fs.lstatSync(`${base}/${name}`);
      if (stat.isDirectory()) {
        if (allowedFiles && !allowedFiles.some((file) => file.startsWith(rel + '/')))
          throw new Error('unlisted_bundle_directory');
        if ((stat.mode & 0o7777) !== 0o700 || stat.uid !== process.getuid())
          throw new Error('unsafe_bundle_directory_mode');
        const fd = fs.openSync(
          `${base}/${name}`,
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
        );
        try {
          walk(`/proc/self/fd/${fd}`, rel);
        } finally {
          fs.closeSync(fd);
        }
      } else if (stat.isFile() && stat.nlink === 1) files.push(rel);
      else throw new Error('links_and_special_files_refused');
      if (files.length > fileLimit) throw new Error('entry_limit');
    }
  }
  directory.assert();
  walk(directory.base, '');
  return files.sort();
}
