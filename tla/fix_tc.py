import io, re

p = 'SnakeDynProtocol.tla'
with io.open(p, encoding='utf-8') as f:
    lines = f.readlines()

out = []
i = 0
n = len(lines)
while i < n:
    line = lines[i]
    if line.startswith('TransClosure(sup) =='):
        # 跳过旧 TransClosure + TCUp 块（到空行前的 TCUp 第二行）
        j = i
        while j < n and not lines[j].startswith('Connected(sup) =='):
            j += 1
        sup_expr = "(sup)"
        new_block = (
            "TransClosure(sup) ==\n"
            "  LET Step1 == {<<a, b>> " + chr(92) + "in sup " + chr(92) + "X sup : b " + chr(92) + "in macroNb(a)}\n"
            "      TC == [nn " + chr(92) + "in 0 .. Cardinality(sup) |->\n"
            "               IF nn = 0 THEN [pp " + chr(92) + "in sup " + chr(92) + "X sup |-> <<pp[1], pp[2]>> " + chr(92) + "in Step1]\n"
            "               ELSE [pp " + chr(92) + "in sup " + chr(92) + "X sup |->\n"
            "                       TC[nn - 1][pp] " + chr(92) + "/ (" + chr(92) + "E b " + chr(92) + "in sup : "
            "TC[nn - 1][<<pp[1], b>>] /" + chr(92) + " TC[nn - 1][<<b, pp[2]>>])]]\n"
            "  IN TC[Cardinality(sup)]\n"
            "\n"
        )
        out.append(new_block)
        # Connected 保持原样（追加后续直到块尾）
        k = j
        while k < n and not (lines[k].startswith('(* ---------------- 初始状态')):
            out.append(lines[k])
            k += 1
        i = k
    else:
        out.append(line)
        i += 1

text = ''.join(out)
# 修 Connected 内 LET 顺序（TC 需在 start 前定义即可，TLA+ LET 并列无序，无需改）
text = text.replace('EXTENDS Naturals, Sequences, TLC',
                    'EXTENDS Naturals, Sequences, FiniteSets, TLC')
with io.open(p, 'w', encoding='utf-8', newline='\n') as f:
    f.write(text)
print('rewritten')
