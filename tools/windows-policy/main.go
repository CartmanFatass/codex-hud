//go:build windows

// Read only the two ClaudeCode Settings registry values and OS-owned folder
// locations. No account, credential, network, profile, or settings writes.
package main

import (
	"encoding/json"
	"os"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

type registryResult struct {
	State string `json:"state"`
	Code  uint32 `json:"code"`
	Kind  uint32 `json:"kind,omitempty"`
	Data  string `json:"data,omitempty"`
}

func registry(hive syscall.Handle) registryResult {
	var key syscall.Handle
	err := syscall.RegOpenKeyEx(hive, syscall.StringToUTF16Ptr(`SOFTWARE\Policies\ClaudeCode`), 0, syscall.KEY_QUERY_VALUE|syscall.KEY_WOW64_64KEY, &key)
	if err != nil {
		return failure(err)
	}
	defer syscall.RegCloseKey(key)
	var kind, size uint32
	name := syscall.StringToUTF16Ptr("Settings")
	if err = syscall.RegQueryValueEx(key, name, nil, &kind, nil, &size); err != nil {
		return failure(err)
	}
	if (kind != syscall.REG_SZ && kind != syscall.REG_EXPAND_SZ) || size > 262144 || size%2 != 0 {
		return registryResult{State: "error", Code: 13}
	}
	data := make([]byte, size+2)
	if err = syscall.RegQueryValueEx(key, name, nil, &kind, &data[0], &size); err != nil {
		return failure(err)
	}
	if size > uint32(len(data)-2) || size%2 != 0 {
		return registryResult{State: "error", Code: 13}
	}
	words := make([]uint16, size/2)
	for i := range words {
		words[i] = uint16(data[2*i]) | uint16(data[2*i+1])<<8
	}
	if len(words) > 0 && words[len(words)-1] == 0 {
		words = words[:len(words)-1]
	}
	for _, word := range words {
		if word == 0 {
			return registryResult{State: "error", Code: 13}
		}
	}
	return registryResult{State: "value", Kind: kind, Data: string(utf16.Decode(words))}
}
func failure(err error) registryResult {
	code, ok := err.(syscall.Errno)
	if !ok {
		return registryResult{State: "error", Code: 1}
	}
	state := "error"
	if code == 2 {
		state = "missing"
	}
	if code == 5 {
		state = "denied"
	}
	return registryResult{State: state, Code: uint32(code)}
}

// kernel32 is a Windows KnownDLL. Load other API libraries with the system-only
// search flag; no PATH, current-directory DLL, environment-selected executable,
// PowerShell profile, or localized CLI diagnostic participates in this protocol.
var kernel = syscall.NewLazyDLL("kernel32.dll")

func systemDLL(name string) syscall.Handle {
	handle, _, _ := kernel.NewProc("LoadLibraryExW").Call(uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr(name))), 0, 0x800)
	if handle == 0 {
		os.Exit(3)
	}
	return syscall.Handle(handle)
}
func main() {
	if len(os.Args) != 1 {
		os.Exit(2)
	}
	system := make([]uint16, 32768)
	length, _, _ := kernel.NewProc("GetSystemDirectoryW").Call(uintptr(unsafe.Pointer(&system[0])), uintptr(len(system)))
	if length == 0 || length >= uintptr(len(system)) {
		os.Exit(3)
	}
	shell := systemDLL("shell32.dll")
	defer syscall.FreeLibrary(shell)
	ole := systemDLL("ole32.dll")
	defer syscall.FreeLibrary(ole)
	getFolder, err := syscall.GetProcAddress(shell, "SHGetKnownFolderPath")
	if err != nil {
		os.Exit(3)
	}
	free, err := syscall.GetProcAddress(ole, "CoTaskMemFree")
	if err != nil {
		os.Exit(3)
	}
	// FOLDERID_ProgramFiles. An OS folder API, never the mutable ProgramFiles env.
	folder := syscall.GUID{Data1: 0x905e63b6, Data2: 0xc1bf, Data3: 0x494e, Data4: [8]byte{0xb2, 0x9c, 0x65, 0xb7, 0x32, 0xd3, 0xd2, 0x1a}}
	var pointer *uint16
	status, _, _ := syscall.SyscallN(getFolder, uintptr(unsafe.Pointer(&folder)), 0, 0, uintptr(unsafe.Pointer(&pointer)))
	if pointer != nil {
		defer syscall.SyscallN(free, uintptr(unsafe.Pointer(pointer)))
	}
	if status != 0 || pointer == nil {
		os.Exit(3)
	}
	var path []uint16
	for _, word := range unsafe.Slice(pointer, 32768) {
		if word == 0 {
			break
		}
		path = append(path, word)
	}
	if len(path) == 0 || len(path) == 32768 {
		os.Exit(3)
	}
	result := struct {
		Protocol        int            `json:"protocol"`
		SystemDirectory string         `json:"systemDirectory"`
		ProgramFiles    string         `json:"programFiles"`
		HKLM            registryResult `json:"hklm"`
		HKCU            registryResult `json:"hkcu"`
	}{1, syscall.UTF16ToString(system[:length]), string(utf16.Decode(path)), registry(syscall.HKEY_LOCAL_MACHINE), registry(syscall.HKEY_CURRENT_USER)}
	if json.NewEncoder(os.Stdout).Encode(result) != nil {
		os.Exit(4)
	}
}
