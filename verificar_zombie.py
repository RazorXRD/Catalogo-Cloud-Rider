#!/usr/bin/env python3
"""Verifica un código de Mano Zombie del catálogo Cloud Rider.
Uso:  python verificar_zombie.py ZB-XXXXXXXXX [dedos_que_dice_el_mensaje]
Debe coincidir ZOMBIE_SALT con el del index.html."""
import sys, datetime
SALT = 'cr-z0mb1e'
B36 = '0123456789abcdefghijklmnopqrstuvwxyz'
def b36(n):
    s = ''
    while n: s = B36[n % 36] + s; n //= 36
    return s or '0'
def zhash(s):
    h = 5381
    for ch in s: h = ((h << 5) + h + ord(ch)) & 0xFFFFFFFF
    return h
code = sys.argv[1].strip().upper()
if not code.startswith('ZB-') or len(code) < 8: sys.exit('Formato inválido')
body = code[3:].lower(); pay, chk = body[:-2], body[-2:]
ok = b36(zhash(pay + SALT) % 1296).zfill(2)[-2:] == chk
ts = datetime.datetime.fromtimestamp(int(pay[:-1], 36))
mask = int(pay[-1], 36); dedos = bin(mask).count('1')
print('Checksum:', 'OK' if ok else 'INVÁLIDO (código alterado)')
print('Generado:', ts.strftime('%Y-%m-%d %H:%M:%S'))
print('Dedos:', dedos, '→ premio', dedos * 100, 'CUP')
if len(sys.argv) > 2 and int(sys.argv[2]) != dedos: print('⚠ El mensaje dice', sys.argv[2], 'dedos pero el código dice', dedos)
