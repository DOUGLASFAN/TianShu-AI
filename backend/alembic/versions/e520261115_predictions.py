"""Private observation defaults and durable, immutable prediction snapshots."""
from alembic import op
import sqlalchemy as sa
revision='e520261115'
down_revision='d420261112'
branch_labels=None
depends_on=None

def upgrade():
    op.add_column('observation_stations',sa.Column('is_default',sa.Boolean(),nullable=False,server_default=sa.false()))
    op.execute('UPDATE observation_stations SET is_default=true WHERE id IN (SELECT DISTINCT ON (user_id) id FROM observation_stations ORDER BY user_id, created_at, id)')
    op.create_index('uq_station_default','observation_stations',['user_id'],unique=True,postgresql_where=sa.text('is_default'))
    op.create_table('predictions',
        sa.Column('id',sa.String(36),primary_key=True),
        sa.Column('user_id',sa.String(36),sa.ForeignKey('users.id',ondelete='CASCADE'),nullable=False),
        sa.Column('status',sa.String(16),nullable=False),sa.Column('progress',sa.Integer(),nullable=False),
        sa.Column('cancel_requested',sa.Boolean(),nullable=False),sa.Column('basis',sa.JSON(),nullable=False),
        sa.Column('results',sa.JSON(),nullable=False),sa.Column('error_code',sa.String(64)),
        sa.Column('created_at',sa.DateTime(timezone=True),nullable=False),
        sa.Column('started_at',sa.DateTime(timezone=True)),sa.Column('finished_at',sa.DateTime(timezone=True)))
    for field in ['user_id','status','created_at']:op.create_index('ix_predictions_'+field,'predictions',[field])

def downgrade():
    op.drop_table('predictions')
    op.drop_index('uq_station_default',table_name='observation_stations')
    op.drop_column('observation_stations','is_default')
